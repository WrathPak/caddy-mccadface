package lan

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/wrathpak/caddy-mccadface/helper/internal/bambu"
)

// SendOptions are the choices that go with a job for these printers.
type SendOptions struct {
	// Storage is where a Prusa stores the file ("/usb", "/local"); empty picks the first one that is ready
	Storage string
}

// Driver is one added printer of the web API kinds.
type Driver interface {
	Start()
	Stop()
	Status() bambu.Status
	Busy() bool
	Pause() error
	Resume() error
	Cancel() error
	// Send uploads a file and starts printing it. Canceling ctx aborts the upload.
	Send(ctx context.Context, name string, data []byte, o SendOptions, progress func(sent int64)) error
	// Request is the helper's proxy: one request to this printer with its credentials added.
	Request(ctx context.Context, method, path string, hdr map[string]string, body []byte) (*Reply, error)
}

// Callbacks tell the owner what happened.
type Callbacks struct {
	OnChange func(bambu.Status)
	OnPin    func(string)
}

// New makes the driver for a kind.
func New(t Target, cb Callbacks) (Driver, error) {
	b := newBase(t, cb)
	switch t.Kind {
	case Prusa:
		return &prusa{base: b}, nil
	case Klipper:
		return &klipper{base: b, raw: map[string]any{}}, nil
	case OctoPrint:
		return &octo{base: b}, nil
	}
	return nil, fmt.Errorf("unknown printer kind %q", t.Kind)
}

// Info is what a probe learns about a printer.
type Info struct {
	Name   string
	Serial string
}

// Probe checks the address and login of a printer once, and says what it is called.
func Probe(ctx context.Context, t Target) (Info, string, error) {
	c := NewClient(t)
	var fp string
	c.OnPin = func(f string) { fp = f }
	var in Info
	var err error
	switch t.Kind {
	case Prusa:
		in, err = probePrusa(ctx, c)
	case Klipper:
		in, err = probeKlipper(ctx, c)
	case OctoPrint:
		in, err = probeOcto(ctx, c)
	default:
		err = fmt.Errorf("unknown printer kind %q", t.Kind)
	}
	if err != nil {
		return in, "", Explain(t, err)
	}
	return in, fp, nil
}

// base holds what every driver shares: the client, the latest status and the stop signal.
type base struct {
	t    Target
	c    *Client
	cb   Callbacks
	mu   sync.Mutex
	st   bambu.Status
	stop chan struct{}
	once sync.Once
	fail int
}

func newBase(t Target, cb Callbacks) *base {
	b := &base{t: t, c: NewClient(t), cb: cb, stop: make(chan struct{})}
	b.c.OnPin = cb.OnPin
	b.st = blank(t)
	return b
}

// blank is a status with nothing known yet.
func blank(t Target) bambu.Status {
	return bambu.Status{PrinterID: t.ID, Kind: t.Kind, State: "unknown", HMS: []bambu.HMS{}, Readouts: []bambu.Readout{}, AMS: bambu.AMS{Units: []bambu.Unit{}}}
}

func (b *base) Stop() { b.once.Do(func() { close(b.stop) }) }

func (b *base) Status() bambu.Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.st
}

func (b *base) Busy() bool {
	switch b.Status().State {
	case "prepare", "running", "pause":
		return true
	}
	return false
}

func (b *base) put(s bambu.Status) {
	s.PrinterID, s.Kind, s.UpdatedAt = b.t.ID, b.t.Kind, time.Now().UnixMilli()
	b.mu.Lock()
	b.st = s
	b.mu.Unlock()
	if b.cb.OnChange != nil {
		b.cb.OnChange(s)
	}
}

// good is a poll that worked.
func (b *base) good(s bambu.Status) {
	b.fail = 0
	s.Online = true
	b.put(s)
}

// bad is a poll that failed: a wrong login shows at once, an unreachable printer after a second miss.
func (b *base) bad(err error) {
	e := Explain(b.t, err)
	if e.Code != CodeBadLogin && e.Code != bambu.CodeCertChanged {
		if b.fail++; b.fail < 2 {
			return
		}
	}
	s := blank(b.t)
	s.Online = false
	s.Problem = &bambu.Problem{Code: e.Code, Message: e.Msg, Old: e.Old, New: e.New}
	b.put(s)
}

func (b *base) Request(ctx context.Context, method, path string, hdr map[string]string, body []byte) (*Reply, error) {
	r, err := b.c.Bytes(ctx, method, path, hdr, body)
	if err != nil {
		return nil, Explain(b.t, err)
	}
	return r, nil
}

// How often a driver polls while a job is active and while it is not. Tests make these short.
var (
	ActiveEvery = 2 * time.Second
	IdleEvery   = 4 * time.Second
)

// loop calls poll again and again, quickly while a job is active and slowly otherwise, until Stop.
func (b *base) loop(poll func(context.Context) (bambu.Status, error)) {
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		s, err := poll(ctx)
		cancel()
		wait := IdleEvery
		if err != nil {
			b.bad(err)
			wait = 5 * time.Second
			if e := Explain(b.t, err); e.Code == CodeBadLogin {
				wait = 15 * time.Second
			}
		} else {
			b.good(s)
			switch s.State {
			case "running", "prepare", "pause":
				wait = ActiveEvery
			}
		}
		select {
		case <-b.stop:
			return
		case <-time.After(wait):
		}
	}
}

// upload sends head, data and tail as one request body (head and tail make a multipart form around the file) and
// reports progress of the data part. A transfer that stops moving for 45 seconds is dropped.
func (b *base) upload(ctx context.Context, method, path string, hdr map[string]string, head, data, tail []byte, progress func(int64)) (*Reply, error) {
	cctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cr := &countReader{progress: progress}
	mk := func() io.Reader {
		cr.mu.Lock()
		cr.n, cr.r = 0, bytes.NewReader(data)
		cr.mu.Unlock()
		return io.MultiReader(bytes.NewReader(head), cr, bytes.NewReader(tail))
	}
	done := make(chan struct{})
	defer close(done)
	go watch(cr, cancel, done)
	resp, err := b.c.Do(cctx, method, path, hdr, mk, int64(len(head)+len(data)+len(tail)))
	if err != nil {
		if ctx.Err() != nil {
			return nil, &bambu.Error{Code: bambu.CodeCancelled, Msg: "Cancelled."}
		}
		if cctx.Err() != nil {
			return nil, &bambu.Error{Code: bambu.CodeUpload, Msg: "The printer stopped taking the file."}
		}
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if progress != nil {
		progress(int64(len(data)))
	}
	return &Reply{Status: resp.StatusCode, Body: body, Header: map[string]string{}}, nil
}

// multipartForm makes the head and tail of a multipart/form-data body around one file part.
func multipartForm(fields [][2]string, field, filename string) (head, tail []byte, ctype string) {
	raw := make([]byte, 12)
	_, _ = rand.Read(raw)
	boundary := "caddylink" + hex.EncodeToString(raw)
	var h bytes.Buffer
	for _, f := range fields {
		fmt.Fprintf(&h, "--%s\r\nContent-Disposition: form-data; name=%q\r\n\r\n%s\r\n", boundary, f[0], f[1])
	}
	fmt.Fprintf(&h, "--%s\r\nContent-Disposition: form-data; name=%q; filename=%q\r\nContent-Type: application/octet-stream\r\n\r\n", boundary, field, filename)
	return h.Bytes(), []byte("\r\n--" + boundary + "--\r\n"), "multipart/form-data; boundary=" + boundary
}

// ---- small JSON helpers over the decoded maps

type obj = map[string]any

func sub(m obj, keys ...string) obj {
	for _, k := range keys {
		next, _ := m[k].(obj)
		if next == nil {
			return nil
		}
		m = next
	}
	return m
}

func f64(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, !math.IsNaN(x)
	case int:
		return float64(x), true
	}
	return 0, false
}

func fOr(v any, def float64) float64 {
	if f, ok := f64(v); ok {
		return f
	}
	return def
}

func s(v any) string {
	x, _ := v.(string)
	return x
}

// minutes rounds seconds up to whole minutes.
func minutes(sec float64) int {
	if sec <= 0 {
		return 0
	}
	return int(math.Ceil(sec / 60))
}

func pct(v float64) int {
	return int(math.Max(0, math.Min(100, math.Round(v))))
}

// escapePath escapes each segment of a file path for a URL.
func escapePath(p string) string {
	parts := strings.Split(strings.Trim(p, "/"), "/")
	for i, x := range parts {
		parts[i] = url.PathEscape(x)
	}
	return strings.Join(parts, "/")
}

var errCancelled = errors.New("cancelled")

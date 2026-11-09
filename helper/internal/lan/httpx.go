// Package lan talks to the printers that use plain web APIs on the LAN: Prusa (PrusaLink), Klipper (Moonraker) and OctoPrint.
// Each kind gets a driver that polls or subscribes for status, sends a file with print-after-upload, and pauses, resumes and
// stops the job. The helper does the talking because these servers send no CORS headers, and so the passwords and API keys
// stay here and never go to the browser.
package lan

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wrathpak/caddy-mccadface/helper/internal/bambu"
)

// Kinds of printer.
const (
	Prusa     = "prusa"
	Klipper   = "klipper"
	OctoPrint = "octoprint"
)

// Error codes, in addition to the ones in package bambu.
const (
	CodeBadLogin  = "bad_login"
	CodeNotReady  = "not_ready"
	CodeNoPrinter = "not_connected"
)

// Target is where a printer is and how to log in.
type Target struct {
	ID       string
	Kind     string
	Host     string
	Port     int
	TLS      bool
	Username string // PrusaLink's digest user, "maker" by default
	Password string
	APIKey   string
	// Fingerprint is the pinned certificate for an https printer, empty until the first connection
	Fingerprint string
}

// DefaultPort is the port each kind listens on when none is given.
func DefaultPort(kind string) int {
	switch kind {
	case Klipper:
		return 7125
	case OctoPrint:
		return 5000
	}
	return 80
}

func (t Target) addr() string {
	p := t.Port
	if p == 0 {
		p = DefaultPort(t.Kind)
	}
	return net.JoinHostPort(t.Host, strconv.Itoa(p))
}

func (t Target) scheme() string {
	if t.TLS {
		return "https"
	}
	return "http"
}

// BaseURL is the printer's web address.
func (t Target) BaseURL() string { return t.scheme() + "://" + t.addr() }

// Reply is what a printer answered to a proxied request.
type Reply struct {
	Status int
	Header map[string]string
	Body   []byte
}

// Client sends requests to one printer with its credentials: an API key header, or HTTP digest or basic authentication.
type Client struct {
	t  Target
	hc *http.Client
	mu sync.Mutex
	ch *challenge
	// OnPin gets the certificate fingerprint of an https printer the first time it is seen
	OnPin func(string)
}

// NewClient makes a client. It never uses a system proxy: the printer is on the local network.
func NewClient(t Target) *Client {
	c := &Client{t: t}
	tr := &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: 8 * time.Second}).DialContext,
		ResponseHeaderTimeout: 40 * time.Second,
		MaxIdleConnsPerHost:   2,
		IdleConnTimeout:       30 * time.Second,
	}
	if t.TLS {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true, VerifyPeerCertificate: c.verify} // pinned in verify, not chained to a CA
	}
	c.hc = &http.Client{Transport: tr}
	return c
}

// verify pins the certificate on first use and refuses a different one afterwards.
func (c *Client) verify(raw [][]byte, _ [][]*x509.Certificate) error {
	if len(raw) == 0 {
		return errors.New("the printer sent no certificate")
	}
	cert, err := x509.ParseCertificate(raw[0])
	if err != nil {
		return err
	}
	fp := bambu.Fingerprint(cert)
	c.mu.Lock()
	pin := c.t.Fingerprint
	if pin == "" {
		c.t.Fingerprint = fp
	}
	c.mu.Unlock()
	if pin == "" {
		if c.OnPin != nil {
			c.OnPin(fp)
		}
		return nil
	}
	if fp != pin {
		return fmt.Errorf("certificate fingerprint changed old=%s new=%s", pin, fp)
	}
	return nil
}

var changedRe = regexp.MustCompile(`old=([0-9a-f]{64}) new=([0-9a-f]{64})`)

// Explain turns a network error into an error with a code and words for the app.
func Explain(t Target, err error) *bambu.Error {
	if err == nil {
		return nil
	}
	var be *bambu.Error
	if errors.As(err, &be) {
		return be
	}
	l := strings.ToLower(err.Error())
	if strings.Contains(l, "fingerprint changed") {
		e := &bambu.Error{Code: bambu.CodeCertChanged, Msg: "The printer's security certificate is not the one that was saved when you added it. If you did not change the printer's address or reinstall it, someone on your network may be pretending to be it."}
		if m := changedRe.FindStringSubmatch(l); m != nil {
			e.Old, e.New = m[1], m[2]
		}
		return e
	}
	if errors.Is(err, context.Canceled) {
		return &bambu.Error{Code: bambu.CodeCancelled, Msg: "Cancelled."}
	}
	m := strings.ReplaceAll(err.Error(), "\n", " ")
	if len(m) > 120 {
		m = m[:120]
	}
	return &bambu.Error{Code: bambu.CodeUnreachable, Msg: fmt.Sprintf("Could not reach the printer at %s. Check that it is on, on the same network, and that the address and port are right (%s).", t.addr(), m)}
}

// ---- authentication

type challenge struct {
	scheme                               string // "digest" or "basic"
	realm, nonce, opaque, qop, algorithm string
	nc                                   uint32
}

var kv = regexp.MustCompile(`([a-zA-Z]+)\s*=\s*(?:"([^"]*)"|([^\s,]*))`)

// parseChallenge reads WWW-Authenticate header values. Digest is preferred over basic when a server offers both.
func parseChallenge(vals []string) *challenge {
	var basic *challenge
	for _, v := range vals {
		v = strings.TrimSpace(v)
		switch {
		case len(v) > 7 && strings.EqualFold(v[:7], "digest "):
			c := &challenge{scheme: "digest", algorithm: "MD5"}
			for _, m := range kv.FindAllStringSubmatch(v[7:], -1) {
				val := m[2]
				if val == "" {
					val = m[3]
				}
				switch strings.ToLower(m[1]) {
				case "realm":
					c.realm = val
				case "nonce":
					c.nonce = val
				case "opaque":
					c.opaque = val
				case "algorithm":
					c.algorithm = val
				case "qop":
					for _, q := range strings.Split(val, ",") {
						if strings.TrimSpace(q) == "auth" {
							c.qop = "auth"
						}
					}
				}
			}
			if c.nonce != "" {
				return c
			}
		case strings.HasPrefix(strings.ToLower(v), "basic"):
			basic = &challenge{scheme: "basic"}
		}
	}
	return basic
}

func hashOf(alg string) func(string) string {
	var nw func() hash.Hash
	switch strings.ToUpper(strings.TrimSuffix(strings.ToUpper(alg), "-SESS")) {
	case "SHA-256":
		nw = sha256.New
	default:
		nw = md5.New
	}
	return func(s string) string { h := nw(); h.Write([]byte(s)); return hex.EncodeToString(h.Sum(nil)) }
}

// header builds the Authorization header for a request, counting the nonce use.
func (ch *challenge) header(user, pass, method, uri string) string {
	h := hashOf(ch.algorithm)
	ch.nc++
	nc := fmt.Sprintf("%08x", ch.nc)
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	cnonce := hex.EncodeToString(b)
	ha1 := h(user + ":" + ch.realm + ":" + pass)
	if strings.HasSuffix(strings.ToLower(ch.algorithm), "-sess") {
		ha1 = h(ha1 + ":" + ch.nonce + ":" + cnonce)
	}
	ha2 := h(method + ":" + uri)
	var resp string
	if ch.qop == "auth" {
		resp = h(ha1 + ":" + ch.nonce + ":" + nc + ":" + cnonce + ":auth:" + ha2)
	} else {
		resp = h(ha1 + ":" + ch.nonce + ":" + ha2)
	}
	s := fmt.Sprintf(`Digest username=%q, realm=%q, nonce=%q, uri=%q, algorithm=%s, response=%q`, user, ch.realm, ch.nonce, uri, ch.algorithm, resp)
	if ch.qop == "auth" {
		s += fmt.Sprintf(`, qop=auth, nc=%s, cnonce=%q`, nc, cnonce)
	}
	if ch.opaque != "" {
		s += fmt.Sprintf(`, opaque=%q`, ch.opaque)
	}
	return s
}

func (c *Client) authorize(req *http.Request) {
	if c.t.APIKey != "" {
		req.Header.Set("X-Api-Key", c.t.APIKey)
		return
	}
	if c.t.Password == "" && c.t.Username == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ch == nil {
		return
	}
	if c.ch.scheme == "basic" {
		req.SetBasicAuth(c.t.Username, c.t.Password)
		return
	}
	req.Header.Set("Authorization", c.ch.header(c.t.Username, c.t.Password, req.Method, req.URL.RequestURI()))
}

// Do sends a request. body may be nil; it is called again if the server asks for a login first, so it must be repeatable.
func (c *Client) Do(ctx context.Context, method, path string, hdr map[string]string, body func() io.Reader, size int64) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		var rd io.Reader
		if body != nil {
			rd = body()
		}
		req, err := http.NewRequestWithContext(ctx, method, c.t.BaseURL()+path, rd)
		if err != nil {
			return nil, err
		}
		if body != nil {
			req.ContentLength = size
			if size == 0 {
				req.Body = http.NoBody
			}
		}
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		c.authorize(req)
		resp, err := c.hc.Do(req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode == http.StatusUnauthorized && attempt == 0 && c.t.APIKey == "" && (c.t.Password != "" || c.t.Username != "") {
			if ch := parseChallenge(resp.Header.Values("Www-Authenticate")); ch != nil {
				io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
				resp.Body.Close()
				c.mu.Lock()
				c.ch = ch
				c.mu.Unlock()
				continue
			}
		}
		return resp, nil
	}
}

// Prime makes one cheap request, so the digest challenge is known before a big body is sent.
func (c *Client) Prime(ctx context.Context, path string) {
	if resp, err := c.Do(ctx, http.MethodGet, path, nil, nil, 0); err == nil {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
		resp.Body.Close()
	}
}

// Bytes does a request with a small body and returns the whole answer (up to 8 MB).
func (c *Client) Bytes(ctx context.Context, method, path string, hdr map[string]string, body []byte) (*Reply, error) {
	var mk func() io.Reader
	if body != nil {
		mk = func() io.Reader { return bytes.NewReader(body) }
	}
	resp, err := c.Do(ctx, method, path, hdr, mk, int64(len(body)))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	r := &Reply{Status: resp.StatusCode, Header: map[string]string{}, Body: b}
	for _, k := range []string{"Content-Type", "Location", "Content-Length", "Retry-After"} {
		if v := resp.Header.Get(k); v != "" {
			r.Header[k] = v
		}
	}
	return r, nil
}

// statusError turns an unwanted HTTP status into an error in plain words.
func statusError(what string, r *Reply) *bambu.Error {
	switch r.Status {
	case 401, 403:
		return &bambu.Error{Code: CodeBadLogin, Msg: "The printer did not accept the login. Check the password or API key in the printer's settings."}
	case 404:
		return &bambu.Error{Code: bambu.CodeUpload, Msg: what + ": the printer does not know that address. Check the printer kind and port."}
	case 409:
		return &bambu.Error{Code: bambu.CodeBusy, Msg: "The printer refused: it is busy, not ready, or a file with that name is in use. " + snippet(r.Body)}
	case 413, 507:
		return &bambu.Error{Code: bambu.CodeSDMissing, Msg: "The printer has no room for the file. " + snippet(r.Body)}
	}
	return &bambu.Error{Code: bambu.CodeUpload, Msg: fmt.Sprintf("%s: the printer answered %d. %s", what, r.Status, snippet(r.Body))}
}

func snippet(b []byte) string {
	s := strings.TrimSpace(strings.Join(strings.Fields(string(b)), " "))
	if strings.HasPrefix(s, "<") {
		return ""
	}
	if len(s) > 160 {
		s = s[:160]
	}
	return s
}

// countReader counts the bytes read, for the upload progress and the stall watchdog.
type countReader struct {
	r        io.Reader
	n        int64
	mu       sync.Mutex
	progress func(int64)
	last     time.Time
}

func (c *countReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.mu.Lock()
	c.n += int64(n)
	n2 := c.n
	tick := time.Since(c.last) > 150*time.Millisecond || err != nil
	if tick {
		c.last = time.Now()
	}
	c.mu.Unlock()
	if tick && c.progress != nil {
		c.progress(n2)
	}
	return n, err
}

func (c *countReader) count() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

// watch cancels the upload when no byte has moved for 45 seconds.
func watch(cr *countReader, cancel context.CancelFunc, done <-chan struct{}) {
	tk := time.NewTicker(5 * time.Second)
	defer tk.Stop()
	prev, stalled := int64(-1), 0
	for {
		select {
		case <-done:
			return
		case <-tk.C:
			if n := cr.count(); n == prev {
				if stalled++; stalled >= 9 {
					cancel()
					return
				}
			} else {
				prev, stalled = n, 0
			}
		}
	}
}

package lan

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/wrathpak/caddy-mccadface/helper/internal/bambu"
)

// Klipper through Moonraker: a WebSocket at /websocket speaking JSON-RPC (server.info, printer.objects.subscribe and the
// notify_status_update notifications), plus HTTP for the file upload (POST /server/files/upload) and the job commands
// (POST /printer/print/pause, resume, cancel). A key, when the printer has one, goes in X-Api-Key.
type klipper struct {
	*base
	mu     sync.Mutex
	raw    obj
	klippy string // klippy_state from server.info: ready, startup, shutdown, error, disconnected
	msg    string
	wsOn   bool
	conn   *websocket.Conn
	next   int
}

func probeKlipper(ctx context.Context, c *Client) (Info, error) {
	m, _, err := getJSON(ctx, c, "/server/info")
	if err != nil {
		return Info{}, err
	}
	in := Info{Name: "Klipper printer"}
	if r := sub(m, "result"); r != nil {
		if s(r["klippy_state"]) == "" && r["moonraker_version"] == nil {
			return in, fmt.Errorf("that address is not Moonraker")
		}
	}
	if p, _, err := getJSON(ctx, c, "/printer/info"); err == nil {
		if h := strings.TrimSpace(s(sub(p, "result")["hostname"])); h != "" {
			in.Name = "Klipper on " + h
		}
	}
	return in, nil
}

var klipperObjects = obj{"print_stats": nil, "display_status": nil, "virtual_sdcard": nil, "extruder": nil, "heater_bed": nil, "fan": nil, "toolhead": nil}

func (k *klipper) Start() { go k.run() }

func (k *klipper) run() {
	wait := 2 * time.Second
	for {
		err := k.session()
		k.mu.Lock()
		k.wsOn, k.conn = false, nil
		k.mu.Unlock()
		select {
		case <-k.stop:
			return
		default:
		}
		if err != nil {
			k.bad(err)
		}
		select {
		case <-k.stop:
			return
		case <-time.After(wait):
		}
	}
}

func (k *klipper) rpc(ctx context.Context, conn *websocket.Conn, method string, params obj) error {
	k.mu.Lock()
	k.next++
	id := k.next
	k.mu.Unlock()
	req := obj{"jsonrpc": "2.0", "method": method, "id": id}
	if params != nil {
		req["params"] = params
	}
	b, _ := json.Marshal(req)
	wctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	return conn.Write(wctx, websocket.MessageText, b)
}

// session holds one WebSocket connection until it breaks or Stop is called.
func (k *klipper) session() error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-k.stop:
			cancel()
		case <-ctx.Done():
		}
	}()
	dctx, dcancel := context.WithTimeout(ctx, 10*time.Second)
	hdr := http.Header{}
	if k.t.APIKey != "" {
		hdr.Set("X-Api-Key", k.t.APIKey)
	}
	ws := "ws"
	if k.t.TLS {
		ws = "wss"
	}
	conn, resp, err := websocket.Dial(dctx, ws+"://"+k.t.addr()+"/websocket", &websocket.DialOptions{HTTPHeader: hdr, HTTPClient: k.c.hc})
	dcancel()
	if err != nil {
		if resp != nil && (resp.StatusCode == 401 || resp.StatusCode == 403) {
			return &bambu.Error{Code: CodeBadLogin, Msg: "Moonraker did not accept the login. Check the API key, or add this computer to trusted_clients in moonraker.conf."}
		}
		return err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(8 << 20)
	k.mu.Lock()
	k.wsOn, k.conn = true, conn
	k.raw = obj{}
	k.mu.Unlock()
	if err := k.rpc(ctx, conn, "server.info", nil); err != nil {
		return err
	}
	// keep asking while klippy is not ready, and refresh the picture now and then in case a notification was missed
	go func() {
		tk := time.NewTicker(10 * time.Second)
		defer tk.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tk.C:
				_ = k.rpc(ctx, conn, "server.info", nil)
			}
		}
	}()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return err
		}
		var m obj
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		k.handle(ctx, conn, m)
	}
}

func (k *klipper) handle(ctx context.Context, conn *websocket.Conn, m obj) {
	switch method := s(m["method"]); method {
	case "notify_status_update":
		if params, _ := m["params"].([]any); len(params) > 0 {
			if ch, _ := params[0].(obj); ch != nil {
				k.mu.Lock()
				bambu.Merge(k.raw, ch)
				k.mu.Unlock()
				k.publish()
			}
		}
		return
	case "notify_klippy_ready", "notify_klippy_shutdown", "notify_klippy_disconnected":
		_ = k.rpc(ctx, conn, "server.info", nil)
		return
	case "":
	default:
		return
	}
	res := sub(m, "result")
	if res == nil {
		return
	}
	if st, ok := res["klippy_state"].(string); ok {
		k.mu.Lock()
		was := k.klippy
		k.klippy = st
		k.mu.Unlock()
		if st == "ready" && was != "ready" {
			_ = k.rpc(ctx, conn, "printer.objects.subscribe", obj{"objects": klipperObjects})
		}
		k.publish()
		return
	}
	// the answer to the subscription is the full first picture
	if sh := sub(res, "status"); sh != nil {
		k.mu.Lock()
		bambu.Merge(k.raw, sh)
		k.mu.Unlock()
		k.publish()
	}
}

var klipperState = map[string]string{"standby": "idle", "printing": "running", "paused": "pause", "complete": "finish", "cancelled": "stopped", "error": "failed"}

func (k *klipper) publish() {
	k.mu.Lock()
	raw, klippy := k.raw, k.klippy
	st := blank(k.t)
	ps, ds, vs := sub(raw, "print_stats"), sub(raw, "display_status"), sub(raw, "virtual_sdcard")
	ex, bed, fan, th := sub(raw, "extruder"), sub(raw, "heater_bed"), sub(raw, "fan"), sub(raw, "toolhead")
	st.GcodeState = s(ps["state"])
	if v, ok := klipperState[st.GcodeState]; ok {
		st.State = v
	}
	st.File = s(ps["filename"])
	st.PrintErrTxt = strings.TrimSpace(s(ps["message"]))
	if info := sub(ps, "info"); info != nil {
		st.Layer, st.TotalLayers = int(fOr(info["current_layer"], 0)), int(fOr(info["total_layer"], 0))
	}
	// the slicer's M73 progress when there is one, else how far into the file the printer is
	progress := fOr(ds["progress"], 0)
	if progress <= 0 {
		progress = fOr(vs["progress"], 0)
	}
	st.Percent = pct(progress * 100)
	if st.State == "finish" {
		st.Percent = 100
	}
	if st.State == "running" && progress > 0.01 {
		dur := fOr(ps["print_duration"], 0)
		st.RemainMin = minutes(dur/progress - dur)
	}
	st.Nozzle = bambu.Temp{Cur: fOr(ex["temperature"], 0), Target: fOr(ex["target"], 0)}
	st.Bed = bambu.Temp{Cur: fOr(bed["temperature"], 0), Target: fOr(bed["target"], 0)}
	if v, ok := f64(fan["speed"]); ok {
		st.Fans = &bambu.Fans{Part: pct(v * 100)}
	}
	if pos, _ := th["position"].([]any); len(pos) >= 3 {
		if z, ok := f64(pos[2]); ok {
			st.Readouts = append(st.Readouts, bambu.Readout{Label: "Height", Value: fmt.Sprintf("%.2f mm", z)})
		}
	}
	on := k.wsOn
	k.mu.Unlock()
	if !on {
		return
	}
	switch klippy {
	case "", "ready":
	default:
		st.Problem = &bambu.Problem{Code: CodeNotReady, Message: "Klipper is " + klippy + ". Check the Klipper log, then restart the firmware from your web interface."}
	}
	k.good(st)
}

func (k *klipper) post(path string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	r, err := k.c.Bytes(ctx, http.MethodPost, path, nil, nil)
	if err != nil {
		return Explain(k.t, err)
	}
	if r.Status/100 != 2 {
		if r.Status == http.StatusBadRequest || r.Status == http.StatusConflict {
			return &bambu.Error{Code: bambu.CodeBusy, Msg: "Klipper cannot do that right now. " + snippet(r.Body)}
		}
		return statusError("Job command", r)
	}
	return nil
}

func (k *klipper) Pause() error  { return k.post("/printer/print/pause") }
func (k *klipper) Resume() error { return k.post("/printer/print/resume") }
func (k *klipper) Cancel() error { return k.post("/printer/print/cancel") }

// Send is POST /server/files/upload (a multipart form: root, print, file) so the file is stored in the gcodes folder and printed.
func (k *klipper) Send(ctx context.Context, name string, data []byte, _ SendOptions, progress func(int64)) error {
	head, tail, ctype := multipartForm([][2]string{{"root", "gcodes"}, {"print", "true"}}, "file", name)
	r, err := k.upload(ctx, http.MethodPost, "/server/files/upload", map[string]string{"Content-Type": ctype}, head, data, tail, progress)
	if err != nil {
		return Explain(k.t, err)
	}
	if r.Status != http.StatusCreated && r.Status != http.StatusOK {
		return statusError("Upload", r)
	}
	var res struct {
		Started bool `json:"print_started"`
		Queued  bool `json:"print_queued"`
	}
	if json.Unmarshal(r.Body, &res) == nil && !res.Started && !res.Queued {
		return &bambu.Error{Code: bambu.CodeRejected, Msg: "The file is on the printer, but Klipper did not start it. It may not be ready, or it may be busy."}
	}
	return nil
}

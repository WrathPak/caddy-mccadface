package server_test

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/wrathpak/caddy-mccadface/helper/internal/bambu"
	"github.com/wrathpak/caddy-mccadface/helper/internal/config"
	"github.com/wrathpak/caddy-mccadface/helper/internal/lan"
	"github.com/wrathpak/caddy-mccadface/helper/internal/mock"
	"github.com/wrathpak/caddy-mccadface/helper/internal/server"
)

// pairedClient connects and pairs a client, like the app does the first time.
func pairedClient(t *testing.T, srv *server.Server, ts *httptest.Server) *client {
	t.Helper()
	c, _, err := dial(t, ts.URL, "http://localhost:5173")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.ws.CloseNow() })
	c.wait(3*time.Second, func(m msg) bool { return m["type"] == "hello" })
	if r := c.call("pair", msg{"code": srv.PairingCode()}); r["type"] != "reply" {
		t.Fatalf("pair: %v", r)
	}
	return c
}

// sendFile sends bytes as a job and returns its last event.
func sendFile(t *testing.T, c *client, id, name string, data []byte) msg {
	t.Helper()
	begin := c.call("send.begin", msg{"printerId": id, "fileName": name, "size": len(data)})
	job, _ := begin["jobId"].(string)
	if job == "" {
		t.Fatalf("send.begin: %v", begin)
	}
	if err := c.ws.Write(context.Background(), websocket.MessageBinary, data); err != nil {
		t.Fatal(err)
	}
	return c.wait(30*time.Second, func(m msg) bool {
		return m["type"] == "send" && m["jobId"] == job && (m["stage"] == "done" || m["stage"] == "error" || m["stage"] == "cancelled")
	})
}

func TestWebPrintersThroughTheHelper(t *testing.T) {
	lan.ActiveEvery, lan.IdleEvery = 200*time.Millisecond, 300*time.Millisecond
	web, err := mock.StartWeb(4)
	if err != nil {
		t.Fatal(err)
	}
	defer web.Close()
	store, err := config.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	srv := server.New(store, server.Options{Version: "test", Mocks: web.Found(), Discover: 300 * time.Millisecond})
	defer srv.Close()
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	c := pairedClient(t, srv, ts)

	// the fake printers show up in discovery with their kind
	kinds := map[string]bool{}
	for _, f := range c.call("printers.discover", nil)["found"].([]any) {
		kinds[f.(msg)["kind"].(string)] = true
	}
	if !kinds["prusa"] || !kinds["klipper"] || !kinds["octoprint"] {
		t.Fatalf("discover kinds: %v", kinds)
	}

	gcode := []byte("; generated\nG1 X1\n" + strings.Repeat("G1 X2 Y2\n", 5000))
	fakes := web.Found()
	for _, k := range []struct {
		kind  string
		port  int
		login msg
	}{
		{"prusa", fakes[0].Port, msg{"password": mock.PrusaPassword}},
		{"klipper", fakes[1].Port, msg{}},
		{"octoprint", fakes[2].Port, msg{"apiKey": mock.OctoKey}},
	} {
		add := msg{"kind": k.kind, "ip": "127.0.0.1", "port": k.port}
		if k.kind == "prusa" {
			wrong := msg{"kind": k.kind, "ip": "127.0.0.1", "port": k.port, "password": "wrong"}
			if r := c.call("printers.add", wrong); r["code"] != "bad_login" {
				t.Fatalf("prusa with a wrong password: %v", r)
			}
		}
		for a, b := range k.login {
			add[a] = b
		}
		r := c.call("printers.add", add)
		pr, _ := r["printer"].(msg)
		if pr == nil || pr["kind"] != k.kind {
			t.Fatalf("add %s: %v", k.kind, r)
		}
		id := pr["id"].(string)
		st := c.status(15*time.Second, func(s msg) bool { return s["printerId"] == id && s["online"] == true })
		if st["state"] != "idle" || st["kind"] != k.kind {
			t.Fatalf("%s status: %v", k.kind, st)
		}
		// a file sent with print-after-upload starts a print that shows in the status
		if e := sendFile(t, c, id, "cube.gcode", gcode); e["stage"] != "done" {
			t.Fatalf("%s send: %v", k.kind, e)
		}
		if got := web.Files(k.kind); len(got) != 1 || got[0] != "cube.gcode" {
			t.Fatalf("%s received: %v", k.kind, got)
		}
		run := c.status(15*time.Second, func(s msg) bool { return s["printerId"] == id && s["state"] == "running" && s["percent"].(float64) > 0 })
		if run["file"] != "cube.gcode" || run["nozzle"].(msg)["target"].(float64) != 215 || (k.kind != "octoprint" && len(run["readouts"].([]any)) == 0) {
			t.Fatalf("%s running status: %v", k.kind, run)
		}
		if k.kind == "klipper" && run["totalLayers"].(float64) != 20 {
			t.Fatalf("klipper layers: %v", run["totalLayers"])
		}
		after := "stopped"
		if k.kind == "octoprint" {
			after = "idle" // OctoPrint goes back to Operational after a cancel
		}
		for _, step := range [][2]string{{"printer.pause", "pause"}, {"printer.resume", "running"}, {"printer.stop", after}} {
			if r := c.call(step[0], msg{"printerId": id}); r["type"] != "reply" {
				t.Fatalf("%s %s: %v", k.kind, step[0], r)
			}
			c.status(10*time.Second, func(s msg) bool { return s["printerId"] == id && s["state"] == step[1] })
		}

		// the proxy only reaches printers that were added, only with a plain path, and adds the login itself
		if k.kind == "prusa" {
			p := c.call("http.request", msg{"printerId": id, "method": "GET", "path": "/api/v1/storage", "headers": msg{"Authorization": "Basic eDp5", "Accept": "application/json"}})
			if p["status"] != float64(200) || !strings.Contains(p["body"].(string), "/usb") {
				t.Fatalf("proxy: %v", p)
			}
			for _, bad := range []string{"//evil.example/x", "http://evil.example/", "api/v1/status", "/a b"} {
				if r := c.call("http.request", msg{"printerId": id, "path": bad}); r["code"] != "bad_request" {
					t.Fatalf("proxy accepted %q: %v", bad, r)
				}
			}
			if r := c.call("http.request", msg{"printerId": "nope", "path": "/api/v1/status"}); r["code"] != "not_found" {
				t.Fatalf("proxy for an unknown printer: %v", r)
			}
		}
	}
	// no password ever goes back to the browser (discovery may offer the fake printer's, which has nothing to protect)
	c.mu.Lock()
	for _, raw := range c.raw {
		if strings.Contains(raw, mock.PrusaPassword) && !strings.Contains(raw, `"found"`) {
			t.Fatalf("a password went back to the browser: %s", raw)
		}
	}
	c.mu.Unlock()
}

// A printer whose certificate changed says so with both fingerprints, and trusting the new one brings it back.
func TestChangedCertificateCanBeTrusted(t *testing.T) {
	fake, err := mock.Start(mock.Options{Speed: 20})
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	found := fake.Found()
	store, _ := config.Open(t.TempDir())
	srv := server.New(store, server.Options{Version: "test", Mocks: []bambu.Found{found}})
	ts := httptest.NewServer(srv.Handler())
	c := pairedClient(t, srv, ts)
	add := c.call("printers.add", msg{"serial": found.Serial, "ip": "127.0.0.1", "accessCode": found.AccessCode, "model": found.Model, "mqttPort": found.MQTTPort, "ftpPort": found.FTPPort})
	id := add["printer"].(msg)["id"].(string)
	ts.Close()
	srv.Close()

	// the pinned fingerprint no longer matches what the printer shows
	old := strings.Repeat("ab", 32)
	if err := store.Update(id, func(p *config.Printer) { p.Fingerprint = old }); err != nil {
		t.Fatal(err)
	}
	srv = server.New(store, server.Options{Version: "test", Mocks: []bambu.Found{found}})
	defer srv.Close()
	ts = httptest.NewServer(srv.Handler())
	defer ts.Close()
	c = pairedClient(t, srv, ts)
	st := c.status(15*time.Second, func(s msg) bool {
		p, _ := s["problem"].(msg)
		return s["printerId"] == id && p != nil && p["code"] == "cert_changed"
	})
	p := st["problem"].(msg)
	if p["oldFingerprint"] != old || len(p["newFingerprint"].(string)) != 64 {
		t.Fatalf("problem: %v", p)
	}
	if r := c.call("printers.trust", msg{"printerId": id, "fingerprint": strings.Repeat("cd", 32)}); r["code"] != "bad_request" {
		t.Fatalf("trusting a fingerprint nobody saw: %v", r)
	}
	if r := c.call("printers.trust", msg{"printerId": id, "fingerprint": p["newFingerprint"]}); r["type"] != "reply" {
		t.Fatalf("trust: %v", r)
	}
	c.status(15*time.Second, func(s msg) bool { return s["printerId"] == id && s["online"] == true && s["problem"] == nil })
}

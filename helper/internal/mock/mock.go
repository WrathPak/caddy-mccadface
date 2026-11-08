// Package mock is a fake Bambu printer for the helper's --mock mode and its tests. It speaks the real protocol on local ports:
// an MQTT broker over TLS (user bblp, the access code as password) and an implicit FTPS server, with an AMS of four colored
// trays. A print started with project_file runs as a simulation: progress, layers, temperatures and the end state.
package mock

import (
	"archive/zip"
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	ftpserver "github.com/fclairamb/ftpserverlib"
	mqtt "github.com/mochi-mqtt/server/v2"
	"github.com/mochi-mqtt/server/v2/listeners"
	"github.com/mochi-mqtt/server/v2/packets"
	"github.com/spf13/afero"

	"github.com/wrathpak/caddy-mccadface/helper/internal/bambu"
)

// Options sets up the mock printer. Zero values pick sensible defaults (random free ports, an A1).
type Options struct {
	Serial     string
	AccessCode string
	Model      string // model code, "N2S" (A1) by default
	Name       string
	MQTTPort   int
	FTPPort    int
	// Speed multiplies the simulation: 1 prints a plate in about a minute
	Speed float64
}

// Printer is a running mock printer.
type Printer struct {
	opt   Options
	mqtt  *mqtt.Server
	ftp   *ftpserver.FtpServer
	fs    afero.Fs
	mu    sync.Mutex
	st    map[string]any // the full "print" object
	sent  map[string]string
	total int
	start time.Time
	stop  chan struct{}
	// Received lists the files that arrived over FTP, for tests
	Received func() []string
}

// freePort is a free port below the system's range for outgoing connections (see passiveBase), or any free one.
func freePort() int {
	for try := 0; try < 100; try++ {
		n, _ := rand.Int(rand.Reader, big.NewInt(10000))
		p := 31000 + int(n.Int64())
		if l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p)); err == nil {
			l.Close()
			return p
		}
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// passiveBase finds 31 free ports in a row below the range the system hands out to outgoing connections, which could otherwise
// take one of them (a data connection to a port that is also somebody's source port is not reliable).
func passiveBase() int {
	for try := 0; try < 200; try++ {
		n, _ := rand.Int(rand.Reader, big.NewInt(10000))
		base := 20000 + int(n.Int64())
		var ls []net.Listener
		ok := true
		for p := base; p <= base+30; p++ {
			l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
			if err != nil {
				ok = false
				break
			}
			ls = append(ls, l)
		}
		for _, l := range ls {
			l.Close()
		}
		if ok {
			return base
		}
	}
	return freePort()
}

func selfSigned(cn string) (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	tpl := &x509.Certificate{
		SerialNumber: serial, Subject: pkix.Name{CommonName: cn, Organization: []string{"CADdy Link mock printer"}},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}

type authHook struct {
	mqtt.HookBase
	code string
}

func (h *authHook) ID() string { return "bambu-auth" }
func (h *authHook) Provides(b byte) bool {
	return b == mqtt.OnConnectAuthenticate || b == mqtt.OnACLCheck
}
func (h *authHook) OnConnectAuthenticate(_ *mqtt.Client, pk packets.Packet) bool {
	return string(pk.Connect.Username) == "bblp" && string(pk.Connect.Password) == h.code
}
func (h *authHook) OnACLCheck(*mqtt.Client, string, bool) bool { return true }

// Start launches the broker and the file server.
func Start(o Options) (*Printer, error) {
	if o.Serial == "" {
		o.Serial = "039MOCK00000001"
	}
	if o.AccessCode == "" {
		o.AccessCode = "12345678"
	}
	if o.Model == "" {
		o.Model = "N2S"
	}
	if o.Name == "" {
		o.Name = "Mock A1"
	}
	if o.MQTTPort == 0 {
		o.MQTTPort = freePort()
	}
	if o.FTPPort == 0 {
		o.FTPPort = freePort()
	}
	if o.Speed <= 0 {
		o.Speed = 1
	}
	cert, err := selfSigned(o.Serial)
	if err != nil {
		return nil, err
	}
	tc := &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	p := &Printer{opt: o, fs: afero.NewMemMapFs(), sent: map[string]string{}, stop: make(chan struct{})}
	p.initState()
	p.Received = func() []string {
		var out []string
		afero.Walk(p.fs, "/", func(path string, i os.FileInfo, err error) error {
			if err == nil && !i.IsDir() {
				out = append(out, filepath.ToSlash(path))
			}
			return nil
		})
		return out
	}

	p.mqtt = mqtt.New(&mqtt.Options{InlineClient: true, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err := p.mqtt.AddHook(&authHook{code: o.AccessCode}, nil); err != nil {
		return nil, err
	}
	l := listeners.NewTCP(listeners.Config{ID: "bambu", Address: fmt.Sprintf("127.0.0.1:%d", o.MQTTPort), TLSConfig: tc})
	if err := p.mqtt.AddListener(l); err != nil {
		return nil, err
	}
	if err := p.mqtt.Subscribe("device/"+o.Serial+"/request", 1, p.onRequest); err != nil {
		return nil, err
	}
	go p.mqtt.Serve()

	base := passiveBase()
	p.ftp = ftpserver.NewFtpServer(&ftpDriver{p: p, tls: tc, port: o.FTPPort, pasv: base})
	if err := p.ftp.Listen(); err != nil {
		p.mqtt.Close()
		return nil, err
	}
	go p.ftp.Serve()
	go p.loop()
	return p, nil
}

// Found is how the mock printer announces itself to the helper's discovery.
func (p *Printer) Found() bambu.Found {
	code, m := bambu.ModelOf(p.opt.Model, p.opt.Serial)
	return bambu.Found{Serial: p.opt.Serial, Name: p.opt.Name, Model: code, ModelNm: m.Name, Label: m.Label, IP: "127.0.0.1",
		MQTTPort: p.opt.MQTTPort, FTPPort: p.opt.FTPPort, Mock: true, AccessCode: p.opt.AccessCode}
}

// Close stops both servers.
func (p *Printer) Close() {
	select {
	case <-p.stop:
		return
	default:
		close(p.stop)
	}
	p.mqtt.Close()
	p.ftp.Stop()
}

func tray(id int, typ, color string, remain int, name string) map[string]any {
	return map[string]any{"id": strconv.Itoa(id), "tray_type": typ, "tray_color": color + "FF", "remain": remain, "tray_sub_brands": name,
		"tray_info_idx": "GFA00", "nozzle_temp_min": "190", "nozzle_temp_max": "240"}
}

func (p *Printer) initState() {
	p.st = map[string]any{
		"gcode_state": "IDLE", "mc_percent": 0, "mc_remaining_time": 0, "layer_num": 0, "total_layer_num": 0,
		"subtask_name": "", "gcode_file": "", "nozzle_temper": 25.0, "nozzle_target_temper": 0.0, "bed_temper": 25.0, "bed_target_temper": 0.0,
		"chamber_temper": 25.0, "cooling_fan_speed": "0", "big_fan1_speed": "0", "big_fan2_speed": "0", "spd_lvl": 2,
		"print_error": 0, "hms": []any{}, "sdcard": true, "wifi_signal": "-48dBm",
		"lights_report": []any{map[string]any{"node": "chamber_light", "mode": "on"}},
		"ams": map[string]any{
			"tray_now": "255",
			"ams": []any{map[string]any{"id": "0", "humidity": "4", "temp": "24.5", "tray": []any{
				tray(0, "PLA", "C12E1F", 88, "Bambu PLA Basic"),
				tray(1, "PLA", "F4EEE0", 64, "Bambu PLA Basic"),
				tray(2, "PETG", "0A2CA5", 41, "Bambu PETG Basic"),
				tray(3, "PLA", "161616", 95, "Bambu PLA Basic"),
			}}},
		},
		"vt_tray": map[string]any{"id": "254", "tray_type": "", "tray_color": "00000000", "remain": 0},
	}
}

func (p *Printer) state() string { return p.st["gcode_state"].(string) }

// onRequest handles a command the helper published.
func (p *Printer) onRequest(_ *mqtt.Client, _ packets.Subscription, pk packets.Packet) {
	var msg map[string]map[string]any
	if json.Unmarshal(pk.Payload, &msg) != nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for group, body := range msg {
		cmd, _ := body["command"].(string)
		seq := fmt.Sprint(body["sequence_id"])
		switch group + "." + cmd {
		case "pushing.pushall":
			p.publishLocked(p.st, true)
		case "print.pause":
			if p.state() == "RUNNING" {
				p.st["gcode_state"] = "PAUSE"
			}
			p.ackLocked(cmd, seq, "success", "")
		case "print.resume":
			if p.state() == "PAUSE" {
				p.st["gcode_state"] = "RUNNING"
			}
			p.ackLocked(cmd, seq, "success", "")
		case "print.stop":
			if s := p.state(); s == "RUNNING" || s == "PAUSE" || s == "PREPARE" {
				p.st["gcode_state"] = "FAILED"
				p.st["print_error"] = 0x0300400C
				p.st["nozzle_target_temper"], p.st["bed_target_temper"] = 0.0, 0.0
				p.st["cooling_fan_speed"] = "0"
			}
			p.ackLocked(cmd, seq, "success", "")
		case "print.print_speed":
			if n, err := strconv.Atoi(fmt.Sprint(body["param"])); err == nil {
				p.st["spd_lvl"] = n
			}
			p.ackLocked(cmd, seq, "success", "")
		case "system.ledctrl":
			p.st["lights_report"] = []any{map[string]any{"node": "chamber_light", "mode": body["led_mode"]}}
			p.ackLocked(cmd, seq, "success", "")
		case "print.project_file":
			p.projectLocked(body, seq)
		}
	}
	p.flushLocked()
}

var layerRe = regexp.MustCompile(`(?m)^;\s*(?:total layer number:|total layers count =)\s*(\d+)`)

func (p *Printer) projectLocked(body map[string]any, seq string) {
	if s := p.state(); s == "RUNNING" || s == "PAUSE" || s == "PREPARE" {
		p.ackLocked("project_file", seq, "fail", "device is busy")
		return
	}
	name := strings.TrimPrefix(fmt.Sprint(body["file"]), "/")
	data, err := afero.ReadFile(p.fs, "/"+name)
	if err != nil {
		p.ackLocked("project_file", seq, "fail", "file not found on storage: "+name)
		return
	}
	p.total = 60
	if zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data))); err == nil {
		for _, f := range zr.File {
			if f.Name == fmt.Sprint(body["param"]) {
				rc, _ := f.Open()
				if rc != nil {
					b, _ := io.ReadAll(rc)
					rc.Close()
					if m := layerRe.FindSubmatch(b); m != nil {
						p.total, _ = strconv.Atoi(string(m[1]))
					}
				}
			}
		}
	} else {
		p.ackLocked("project_file", seq, "fail", "not a 3mf")
		return
	}
	// the AMS mapping must point at trays that exist, like the real firmware checks
	if m, ok := body["ams_mapping"].([]any); ok {
		for _, v := range m {
			if n, _ := v.(float64); n > 3 {
				p.ackLocked("project_file", seq, "fail", "AMS mapping table is not valid")
				return
			}
		}
	}
	p.st["gcode_state"] = "PREPARE"
	p.st["print_error"] = 0
	p.st["subtask_name"] = fmt.Sprint(body["subtask_name"])
	p.st["gcode_file"] = name
	p.st["mc_percent"], p.st["layer_num"], p.st["total_layer_num"] = 0, 0, p.total
	p.st["nozzle_target_temper"], p.st["bed_target_temper"] = 220.0, 60.0
	p.st["mc_remaining_time"] = 1 + int(math.Ceil(1/p.opt.Speed))
	p.start = time.Time{}
	if m, ok := body["ams_mapping"].([]any); ok && len(m) > 0 {
		if n, _ := m[0].(float64); n >= 0 {
			p.st["ams"].(map[string]any)["tray_now"] = strconv.Itoa(int(n))
		}
	}
	p.ackLocked("project_file", seq, "success", "")
}

func (p *Printer) ackLocked(cmd, seq, result, reason string) {
	b, _ := json.Marshal(map[string]any{"print": map[string]any{"command": cmd, "sequence_id": seq, "result": result, "reason": reason}})
	p.mqtt.Publish("device/"+p.opt.Serial+"/report", b, false, 0)
}

// publishLocked sends the whole object (all = true) or only what changed since the last report, like a P1 does.
func (p *Printer) publishLocked(obj map[string]any, all bool) {
	out := map[string]any{"command": "push_status", "msg": 0, "sequence_id": "2021"}
	n := 0
	for k, v := range obj {
		b, _ := json.Marshal(v)
		if all || p.sent[k] != string(b) {
			out[k] = v
			p.sent[k] = string(b)
			n++
		}
	}
	if n == 0 {
		return
	}
	b, _ := json.Marshal(map[string]any{"print": out})
	p.mqtt.Publish("device/"+p.opt.Serial+"/report", b, false, 0)
}

func (p *Printer) flushLocked() { p.publishLocked(p.st, false) }

func approach(cur, target, step float64) float64 {
	if math.Abs(target-cur) <= step {
		return target
	}
	if cur < target {
		return cur + step
	}
	return cur - step
}

// loop runs the simulation twice a second.
func (p *Printer) loop() {
	tk := time.NewTicker(500 * time.Millisecond)
	defer tk.Stop()
	for {
		select {
		case <-p.stop:
			return
		case <-tk.C:
		}
		p.mu.Lock()
		dt := 0.5 * p.opt.Speed
		nt, _ := p.st["nozzle_target_temper"].(float64)
		bt, _ := p.st["bed_target_temper"].(float64)
		tn, tb := approach(p.st["nozzle_temper"].(float64), math.Max(nt, 25), 40*dt), approach(p.st["bed_temper"].(float64), math.Max(bt, 25), 12*dt)
		p.st["nozzle_temper"], p.st["bed_temper"] = math.Round(tn*10)/10, math.Round(tb*10)/10
		switch p.state() {
		case "PREPARE":
			if tn >= nt-1 && tb >= bt-1 {
				p.st["gcode_state"] = "RUNNING"
				p.start = time.Now()
				p.st["cooling_fan_speed"] = "15"
			}
		case "RUNNING":
			if p.start.IsZero() {
				p.start = time.Now()
			}
			// a plate takes about a minute at speed 1; a pause moves the start so it does not count
			pct := int(math.Min(100, time.Since(p.start).Seconds()*p.opt.Speed/60*100))
			p.st["mc_percent"] = pct
			p.st["layer_num"] = pct * p.total / 100
			p.st["mc_remaining_time"] = int(math.Ceil(float64(100-pct) / 100 * 60 / p.opt.Speed / 60))
			if pct >= 100 {
				p.st["gcode_state"] = "FINISH"
				p.st["nozzle_target_temper"], p.st["bed_target_temper"] = 0.0, 0.0
				p.st["cooling_fan_speed"] = "0"
				p.st["layer_num"] = p.total
			}
		case "PAUSE":
			p.start = p.start.Add(500 * time.Millisecond)
		}
		p.flushLocked()
		p.mu.Unlock()
	}
}

// ftpDriver serves one in-memory file system to anyone who knows the access code.
type ftpDriver struct {
	p    *Printer
	tls  *tls.Config
	port int
	pasv int
}

func (d *ftpDriver) GetSettings() (*ftpserver.Settings, error) {
	return &ftpserver.Settings{
		ListenAddr: fmt.Sprintf("127.0.0.1:%d", d.port), PublicHost: "127.0.0.1", TLSRequired: ftpserver.ImplicitEncryption,
		PassiveTransferPortRange: ftpserver.PortRange{Start: d.pasv, End: d.pasv + 30}, DisableActiveMode: true,
		IdleTimeout: 120, ConnectionTimeout: 30,
	}, nil
}
func (d *ftpDriver) ClientConnected(ftpserver.ClientContext) (string, error) {
	return "mock printer", nil
}
func (d *ftpDriver) ClientDisconnected(ftpserver.ClientContext) {}
func (d *ftpDriver) GetTLSConfig() (*tls.Config, error)         { return d.tls, nil }
func (d *ftpDriver) AuthUser(_ ftpserver.ClientContext, user, pass string) (ftpserver.ClientDriver, error) {
	if user != "bblp" || pass != d.p.opt.AccessCode {
		return nil, errors.New("bad login")
	}
	return d.p.fs, nil
}

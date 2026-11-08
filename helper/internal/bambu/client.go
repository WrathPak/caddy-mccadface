package bambu

import (
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
)

// Error codes shared with the app (src/features/print/link/protocol.ts).
const (
	CodeUnreachable = "unreachable"
	CodeBadAccess   = "bad_access_code"
	CodeCertChanged = "cert_changed"
	CodeOffline     = "offline"
	CodeBusy        = "busy"
	CodeDevMode     = "dev_mode"
	CodeSDMissing   = "sd_missing"
	CodeUpload      = "upload_failed"
	CodeRejected    = "print_rejected"
)

// Error is a failure with a code the app can show in plain words.
type Error struct {
	Code string
	Msg  string
}

func (e *Error) Error() string { return e.Msg }

func fail(code, format string, a ...any) *Error {
	return &Error{Code: code, Msg: fmt.Sprintf(format, a...)}
}

// Target is where a printer is and how to log in.
type Target struct {
	ID          string
	Serial      string
	Host        string
	MQTTPort    int
	FTPPort     int
	AccessCode  string
	Fingerprint string // pinned certificate, empty until the first connection
}

func (t Target) mqttAddr() string {
	p := t.MQTTPort
	if p == 0 {
		p = 8883
	}
	return net.JoinHostPort(t.Host, strconv.Itoa(p))
}

func (t Target) ftpAddr() string {
	p := t.FTPPort
	if p == 0 {
		p = 990
	}
	return net.JoinHostPort(t.Host, strconv.Itoa(p))
}

// Fingerprint is the SHA-256 of a certificate, as hex.
func Fingerprint(cert *x509.Certificate) string {
	h := sha256.Sum256(cert.Raw)
	return hex.EncodeToString(h[:])
}

// tlsConfig trusts the printer's self-signed certificate on first use: it pins the fingerprint it sees, and refuses a
// different one afterwards. seen reports the fingerprint of every handshake. The server name is the printer's serial (the name
// in its certificate, which Bambu's server expects as SNI), and the same on every connection, so that a TLS session cached on
// the control connection is found again by the data connection.
func tlsConfig(serverName, pinned string, seen func(string)) *tls.Config {
	return &tls.Config{
		InsecureSkipVerify: true, // the certificate is pinned below, not chained to a CA
		ServerName:         serverName,
		ClientSessionCache: tls.NewLRUClientSessionCache(8),
		VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
			if len(raw) == 0 {
				return errors.New("the printer sent no certificate")
			}
			cert, err := x509.ParseCertificate(raw[0])
			if err != nil {
				return err
			}
			fp := Fingerprint(cert)
			if pinned != "" && fp != pinned {
				return errors.New("certificate fingerprint changed")
			}
			if seen != nil {
				seen(fp)
			}
			return nil
		},
	}
}

// Client keeps one MQTT connection to a printer and the merged state of its reports.
type Client struct {
	t        Target
	model    Model
	mu       sync.Mutex
	raw      map[string]any
	online   bool
	problem  *Problem
	conn     mqtt.Client
	seq      int
	acks     map[string]chan map[string]any
	stopOnce sync.Once
	stop     chan struct{}

	// OnChange is called with the new status after every report. OnPin is called with the certificate fingerprint on first use.
	OnChange func(Status)
	OnPin    func(string)
}

// NewClient prepares a client; Start connects.
func NewClient(t Target, m Model) *Client {
	return &Client{t: t, model: m, raw: map[string]any{}, stop: make(chan struct{}), acks: map[string]chan map[string]any{}}
}

func (c *Client) topicReport() string  { return "device/" + c.t.Serial + "/report" }
func (c *Client) topicRequest() string { return "device/" + c.t.Serial + "/request" }

func mqttOptions(t Target, retry bool, seen func(string)) *mqtt.ClientOptions {
	o := mqtt.NewClientOptions()
	o.AddBroker("ssl://" + t.mqttAddr())
	o.SetUsername("bblp").SetPassword(t.AccessCode)
	o.SetClientID("caddy-link-" + t.Serial + "-" + strconv.FormatInt(time.Now().UnixNano()%1e6, 10))
	o.SetKeepAlive(30 * time.Second)
	o.SetPingTimeout(10 * time.Second)
	o.SetConnectTimeout(8 * time.Second)
	o.SetCleanSession(true)
	o.SetTLSConfig(tlsConfig(t.Serial, t.Fingerprint, seen))
	o.SetAutoReconnect(retry)
	o.SetConnectRetry(retry)
	o.SetConnectRetryInterval(5 * time.Second)
	o.SetMaxReconnectInterval(30 * time.Second)
	return o
}

// explain turns a connection error into a code and words.
func explain(err error) *Error {
	m := err.Error()
	l := strings.ToLower(m)
	switch {
	case strings.Contains(l, "fingerprint changed"):
		return fail(CodeCertChanged, "The printer's security certificate changed since you added it. If you did not reset the printer, someone may be on your network. Remove the printer and add it again to trust the new one.")
	case strings.Contains(l, "bad user name") || strings.Contains(l, "not authorized") || strings.Contains(l, "not authorised"):
		return fail(CodeBadAccess, "The printer refused the access code. Check it on the printer's screen (Settings, WLAN or Network). Turning Developer Mode on or off changes it.")
	}
	return fail(CodeUnreachable, "Could not reach the printer. Check that it is on, on the same network, and in LAN Only mode (%s).", shorten(m))
}

func shorten(s string) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > 120 {
		return s[:120]
	}
	return s
}

// Probe connects once, without retrying, to check the address and access code and read the certificate fingerprint.
func Probe(t Target) (string, error) {
	var fp string
	o := mqttOptions(t, false, func(f string) { fp = f })
	cl := mqtt.NewClient(o)
	tok := cl.Connect()
	if !tok.WaitTimeout(12 * time.Second) {
		cl.Disconnect(0)
		return "", fail(CodeUnreachable, "The printer did not answer at %s. Check the address and that it is on and in LAN Only mode.", t.mqttAddr())
	}
	if err := tok.Error(); err != nil {
		return "", explain(err)
	}
	cl.Disconnect(100)
	return fp, nil
}

// Start connects and keeps reconnecting until Stop.
func (c *Client) Start() {
	o := mqttOptions(c.t, true, func(fp string) {
		if c.t.Fingerprint == "" && c.OnPin != nil {
			c.t.Fingerprint = fp
			c.OnPin(fp)
		}
	})
	o.SetOnConnectHandler(func(cl mqtt.Client) {
		c.mu.Lock()
		c.online, c.problem = true, nil
		c.mu.Unlock()
		tok := cl.Subscribe(c.topicReport(), 0, c.onMessage)
		tok.Wait()
		c.pushAll()
		c.emit()
	})
	o.SetConnectionLostHandler(func(_ mqtt.Client, err error) {
		c.mu.Lock()
		c.online = false
		c.mu.Unlock()
		c.emit()
	})
	o.SetReconnectingHandler(func(_ mqtt.Client, _ *mqtt.ClientOptions) {})
	c.conn = mqtt.NewClient(o)
	go func() {
		tok := c.conn.Connect()
		tok.Wait()
		if err := tok.Error(); err != nil {
			e := explain(err)
			c.mu.Lock()
			c.online, c.problem = false, &Problem{Code: e.Code, Message: e.Msg}
			c.mu.Unlock()
			c.emit()
		}
	}()
	// P1 printers only send what changed; ask for everything now and then (not under 5 minutes, it lags the P1P)
	go func() {
		tk := time.NewTicker(5 * time.Minute)
		defer tk.Stop()
		for {
			select {
			case <-tk.C:
				c.pushAll()
			case <-c.stop:
				return
			}
		}
	}()
}

// Stop disconnects.
func (c *Client) Stop() {
	c.stopOnce.Do(func() {
		close(c.stop)
		if c.conn != nil {
			c.conn.Disconnect(100)
		}
	})
}

func (c *Client) onMessage(_ mqtt.Client, m mqtt.Message) {
	var msg map[string]map[string]any
	if json.Unmarshal(m.Payload(), &msg) != nil {
		return
	}
	if p, ok := msg["print"]; ok {
		c.mu.Lock()
		if p["command"] == "push_status" || p["command"] == nil {
			Merge(c.raw, p)
		}
		if id := fmt.Sprint(p["sequence_id"]); id != "" {
			if ch, ok := c.acks[id]; ok && p["command"] != "push_status" {
				select {
				case ch <- p:
				default:
				}
			}
		}
		c.mu.Unlock()
		c.emit()
	}
}

// Status is the current normalized state.
func (c *Client) Status() Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := Normalize(c.t.ID, c.online, c.raw)
	s.Problem = c.problem
	return s
}

func (c *Client) emit() {
	if c.OnChange != nil {
		c.OnChange(c.Status())
	}
}

func (c *Client) publish(group string, body map[string]any) (string, error) {
	c.mu.Lock()
	c.seq++
	id := strconv.Itoa(20000 + c.seq)
	online := c.online
	c.mu.Unlock()
	if !online || c.conn == nil {
		return "", fail(CodeOffline, "The printer is offline.")
	}
	body["sequence_id"] = id
	b, _ := json.Marshal(map[string]any{group: body})
	tok := c.conn.Publish(c.topicRequest(), 1, false, b)
	if !tok.WaitTimeout(8 * time.Second) {
		return "", fail(CodeOffline, "The printer did not take the command.")
	}
	return id, tok.Error()
}

func (c *Client) pushAll() {
	if c.conn == nil || !c.conn.IsConnectionOpen() {
		return
	}
	b, _ := json.Marshal(map[string]any{"pushing": map[string]any{"sequence_id": "0", "command": "pushall", "version": 1, "push_target": 1}})
	c.conn.Publish(c.topicRequest(), 0, false, b)
}

// Pause, Resume and Stop control the running print.
func (c *Client) Pause() error {
	_, err := c.publish("print", map[string]any{"command": "pause", "param": ""})
	return err
}
func (c *Client) Resume() error {
	_, err := c.publish("print", map[string]any{"command": "resume", "param": ""})
	return err
}
func (c *Client) Cancel() error {
	_, err := c.publish("print", map[string]any{"command": "stop", "param": ""})
	return err
}

// Light turns the chamber light on or off.
func (c *Client) Light(on bool) error {
	mode := "off"
	if on {
		mode = "on"
	}
	_, err := c.publish("system", map[string]any{"command": "ledctrl", "led_node": "chamber_light", "led_mode": mode,
		"led_on_time": 500, "led_off_time": 500, "loop_times": 0, "interval_time": 0})
	return err
}

// Speed sets the speed level: 1 silent, 2 standard, 3 sport, 4 ludicrous.
func (c *Client) Speed(level int) error {
	if level < 1 || level > 4 {
		return fail("bad_request", "Speed level is 1 to 4.")
	}
	_, err := c.publish("print", map[string]any{"command": "print_speed", "param": strconv.Itoa(level)})
	return err
}

// Busy says whether a print is running or being prepared.
func (c *Client) Busy() bool {
	switch c.Status().State {
	case "prepare", "running", "pause":
		return true
	}
	return false
}

// StartOptions are the choices that go with a job.
type StartOptions struct {
	File        string // the name the file was uploaded under
	Plate       int
	UseAMS      bool
	AMSMapping  []int // per project filament: global tray id, 254 external, -1 unused
	BedLeveling bool
	FlowCali    bool
	Timelapse   bool
}

// StartPrint sends project_file for a file already on the printer, and waits for the printer to answer it.
// The fields follow what Bambu Studio sends, as ha-bambulab and Bambuddy reproduce it.
func (c *Client) StartPrint(o StartOptions) error {
	st := c.Status()
	if !st.Online {
		return fail(CodeOffline, "The printer is offline.")
	}
	if c.Busy() {
		return fail(CodeBusy, "The printer is already printing. Wait for it to finish, or stop it first.")
	}
	if o.Plate == 0 {
		o.Plate = 1
	}
	if len(o.AMSMapping) == 0 {
		// no AMS: the job prints from the external spool
		o.AMSMapping = []int{254}
	}
	flat := []int{}
	map2 := []map[string]int{}
	useAMS := o.UseAMS
	external, real := 0, 0
	for _, id := range o.AMSMapping {
		switch {
		case id < 0:
			flat = append(flat, -1)
			map2 = append(map2, map[string]int{"ams_id": 255, "slot_id": 255})
		case id >= 254:
			// the external spool: Studio sends -1 in the flat list and the details in ams_mapping2
			ext := 255
			if c.model.Dual {
				ext = id
			}
			flat = append(flat, -1)
			map2 = append(map2, map[string]int{"ams_id": ext, "slot_id": 0})
			external++
		case id >= 128:
			flat = append(flat, id)
			map2 = append(map2, map[string]int{"ams_id": id, "slot_id": 0})
			real++
		default:
			flat = append(flat, id)
			map2 = append(map2, map[string]int{"ams_id": id / 4, "slot_id": id % 4})
			real++
		}
	}
	// a real tray means the AMS feeds this print; only external spools means it does not
	if len(o.AMSMapping) > 0 && !c.model.Dual {
		if real > 0 {
			useAMS = true
		} else if external > 0 {
			useAMS = false
		}
	}
	if len(st.AMS.Units) == 0 && !c.model.Dual {
		useAMS = false
	}
	submission := strconv.FormatInt(time.Now().UnixMilli()%2147483647, 10)
	onoff := func(b bool) int {
		if b {
			return 1
		}
		return 0
	}
	body := map[string]any{
		"command":                  "project_file",
		"param":                    fmt.Sprintf("Metadata/plate_%d.gcode", o.Plate),
		"url":                      "ftp://" + o.File,
		"file":                     o.File,
		"md5":                      "",
		"bed_type":                 "auto",
		"timelapse":                o.Timelapse,
		"bed_leveling":             o.BedLeveling,
		"auto_bed_leveling":        onoff(o.BedLeveling),
		"flow_cali":                o.FlowCali,
		"extrude_cali_flag":        onoff(o.FlowCali),
		"vibration_cali":           !c.model.NoVibration,
		"layer_inspect":            false,
		"use_ams":                  useAMS,
		"subtask_name":             strings.TrimSuffix(strings.TrimSuffix(o.File, ".3mf"), ".gcode"),
		"profile_id":               "0",
		"project_id":               submission,
		"subtask_id":               submission,
		"task_id":                  submission,
		"nozzle_offset_cali":       0,
		"extrude_cali_manual_mode": 0,
	}
	if len(o.AMSMapping) > 0 {
		body["ams_mapping"] = flat
		body["ams_mapping2"] = map2
	}
	// register for the answer before sending it
	c.mu.Lock()
	c.seq++
	id := strconv.Itoa(20000 + c.seq)
	ch := make(chan map[string]any, 4)
	c.acks[id] = ch
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.acks, id); c.mu.Unlock() }()
	body["sequence_id"] = id
	b, _ := json.Marshal(map[string]any{"print": body})
	tok := c.conn.Publish(c.topicRequest(), 1, false, b)
	if !tok.WaitTimeout(8*time.Second) || tok.Error() != nil {
		return fail(CodeOffline, "The printer did not take the print command.")
	}
	deadline := time.After(20 * time.Second)
	for {
		select {
		case p := <-ch:
			if p["command"] != "project_file" {
				continue
			}
			if res := strings.ToLower(str(p["result"])); res == "fail" || res == "failed" {
				reason := str(p["reason"])
				if reason == "" {
					reason = "no reason given"
				}
				return fail(CodeRejected, "The printer would not start the print (%s). If this keeps happening, check that Developer Mode is on.", reason)
			}
			return nil
		case <-time.After(500 * time.Millisecond):
			// some firmware starts without an answer: a state change counts
			switch c.Status().State {
			case "prepare", "running":
				return nil
			}
		case <-deadline:
			return fail(CodeDevMode, "The printer did not answer the print command. Check that Developer Mode is on (with LAN Only mode) and that the access code is current.")
		}
	}
}

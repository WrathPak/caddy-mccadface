package server

import (
	"context"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wrathpak/caddy-mccadface/helper/internal/bambu"
	"github.com/wrathpak/caddy-mccadface/helper/internal/config"
	"github.com/wrathpak/caddy-mccadface/helper/internal/lan"
)

// controller is what every kind of printer can do to a running job.
type controller interface {
	Pause() error
	Resume() error
	Cancel() error
	Busy() bool
	Status() bambu.Status
}

// Manager holds one live connection per stored printer (an MQTT client for Bambu, a driver for the web API kinds) and the
// latest status of each.
type Manager struct {
	store    *config.Store
	logf     func(string, ...any)
	mu       sync.Mutex
	clients  map[string]*bambu.Client
	drivers  map[string]lan.Driver
	last     map[string]bambu.Status
	dirty    map[string]bool
	online   map[string]bool
	OnStatus func(bambu.Status)
	stop     chan struct{}
}

// NewManager makes a manager; Run starts the clients and the status flusher.
func NewManager(store *config.Store, logf func(string, ...any)) *Manager {
	return &Manager{store: store, logf: logf, clients: map[string]*bambu.Client{}, drivers: map[string]lan.Driver{}, last: map[string]bambu.Status{},
		dirty: map[string]bool{}, online: map[string]bool{}, stop: make(chan struct{})}
}

func target(p config.Printer) bambu.Target {
	return bambu.Target{ID: p.ID, Serial: p.Serial, Host: p.IP, MQTTPort: p.MQTTPort, FTPPort: p.FTPPort, AccessCode: p.AccessCode, Fingerprint: p.Fingerprint}
}

func lanTarget(p config.Printer) lan.Target {
	return lan.Target{ID: p.ID, Kind: p.Kind, Host: p.IP, Port: p.Port, TLS: p.TLS, Username: p.Username, Password: p.Password, APIKey: p.APIKey, Fingerprint: p.Fingerprint}
}

var kindName = map[string]string{lan.Prusa: "PrusaLink", lan.Klipper: "Klipper", lan.OctoPrint: "OctoPrint"}

// Info is the printer without its secrets.
func Info(p config.Printer) PrinterInfo {
	if !p.IsBambu() {
		port := p.Port
		if port == 0 {
			port = lan.DefaultPort(p.Kind)
		}
		return PrinterInfo{ID: p.ID, Name: p.Name, ModelName: kindName[p.Kind], Serial: p.Serial, IP: p.IP, Pinned: p.Fingerprint != "", Mock: p.Mock,
			Kind: p.Kind, Port: port, TLS: p.TLS, Secret: p.Password != "" || p.APIKey != ""}
	}
	code, m := bambu.ModelOf(p.Model, p.Serial)
	return PrinterInfo{ID: p.ID, Name: p.Name, Model: code, ModelName: m.Name, ModelLabel: m.Label, Serial: p.Serial, IP: p.IP,
		Pinned: p.Fingerprint != "", Storage: m.Storage, Mock: p.Mock, Kind: "bambu"}
}

// Infos lists every printer.
func (m *Manager) Infos() []PrinterInfo {
	ps := m.store.Printers()
	out := make([]PrinterInfo, 0, len(ps))
	for _, p := range ps {
		out = append(out, Info(p))
	}
	return out
}

// Run connects to every stored printer and starts pushing status changes.
func (m *Manager) Run() {
	for _, p := range m.store.Printers() {
		m.connect(p)
	}
	go func() {
		tk := time.NewTicker(400 * time.Millisecond)
		defer tk.Stop()
		for n := 1; ; n++ {
			select {
			case <-m.stop:
				return
			case <-tk.C:
				// every few seconds every printer's status goes out again, so a browser that missed one (it connected
				// or added a printer a moment too late) catches up without waiting for something to change
				if n%10 == 0 {
					m.MarkAll()
				}
				m.flush()
			}
		}
	}()
}

// MarkAll queues the latest status of every printer to be sent.
func (m *Manager) MarkAll() {
	m.mu.Lock()
	for id := range m.last {
		if _, ok := m.clients[id]; ok {
			m.dirty[id] = true
		} else if _, ok := m.drivers[id]; ok {
			m.dirty[id] = true
		}
	}
	m.mu.Unlock()
}

func (m *Manager) flush() {
	m.mu.Lock()
	var out []bambu.Status
	for id := range m.dirty {
		if s, ok := m.last[id]; ok {
			out = append(out, s)
		}
		delete(m.dirty, id)
	}
	m.mu.Unlock()
	for _, s := range out {
		if m.OnStatus != nil {
			m.OnStatus(s)
		}
	}
}

// changed takes a new status of a printer.
func (m *Manager) changed(p config.Printer, s bambu.Status) {
	m.mu.Lock()
	m.last[p.ID] = s
	m.dirty[p.ID] = true
	was, known := m.online[p.ID]
	m.online[p.ID] = s.Online
	m.mu.Unlock()
	switch {
	case s.Problem != nil && (!known || was):
		m.logf("%s: %s", p.Name, s.Problem.Message)
	case s.Online && (!known || !was):
		m.logf("%s is online.", p.Name)
	case !s.Online && known && was:
		m.logf("%s went offline. Trying again.", p.Name)
	}
}

func (m *Manager) pin(p config.Printer) func(string) {
	return func(fp string) {
		_ = m.store.Update(p.ID, func(x *config.Printer) { x.Fingerprint = fp })
		m.logf("Pinned the certificate of %s.", p.Name)
	}
}

func (m *Manager) connect(p config.Printer) {
	m.mu.Lock()
	if old, ok := m.clients[p.ID]; ok {
		old.Stop()
		delete(m.clients, p.ID)
	}
	if old, ok := m.drivers[p.ID]; ok {
		old.Stop()
		delete(m.drivers, p.ID)
	}
	m.mu.Unlock()
	if !p.IsBambu() {
		d, err := lan.New(lanTarget(p), lan.Callbacks{OnChange: func(s bambu.Status) { m.changed(p, s) }, OnPin: m.pin(p)})
		if err != nil {
			m.logf("%s: %v", p.Name, err)
			return
		}
		m.mu.Lock()
		m.drivers[p.ID] = d
		m.mu.Unlock()
		d.Start()
		return
	}
	_, model := bambu.ModelOf(p.Model, p.Serial)
	c := bambu.NewClient(target(p), model)
	c.OnPin = m.pin(p)
	c.OnChange = func(s bambu.Status) { m.changed(p, s) }
	m.mu.Lock()
	m.clients[p.ID] = c
	m.mu.Unlock()
	c.Start()
}

// Client returns the live Bambu client of a printer (nil for the other kinds).
func (m *Manager) Client(id string) *bambu.Client {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.clients[id]
}

// Driver returns the live driver of a printer of the web API kinds (nil for Bambu).
func (m *Manager) Driver(id string) lan.Driver {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.drivers[id]
}

// Controller returns whatever controls a printer's job, of any kind.
func (m *Manager) Controller(id string) controller {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.clients[id]; ok {
		return c
	}
	if d, ok := m.drivers[id]; ok {
		return d
	}
	return nil
}

// Statuses returns the latest status of every printer that has one.
func (m *Manager) Statuses() []bambu.Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]bambu.Status, 0, len(m.clients)+len(m.drivers))
	for id, c := range m.clients {
		if s, ok := m.last[id]; ok {
			out = append(out, s)
		} else {
			out = append(out, c.Status())
		}
	}
	for id, d := range m.drivers {
		if s, ok := m.last[id]; ok {
			out = append(out, s)
		} else {
			out = append(out, d.Status())
		}
	}
	return out
}

// Add checks a printer (address, login, certificate), keeps it and connects to it.
func (m *Manager) Add(r addReq, mock bool) (config.Printer, error) {
	if r.Kind != "" && r.Kind != "bambu" {
		return m.addLAN(r, mock)
	}
	serial := strings.ToUpper(strings.TrimSpace(r.Serial))
	ip := strings.TrimSpace(r.IP)
	if serial == "" || ip == "" || strings.TrimSpace(r.AccessCode) == "" {
		return config.Printer{}, &bambu.Error{Code: ErrBadRequest, Msg: "A printer needs an IP address, a serial number and an access code."}
	}
	if net.ParseIP(ip) == nil && strings.ContainsAny(ip, " /\\:") {
		return config.Printer{}, &bambu.Error{Code: ErrBadRequest, Msg: "That does not look like an IP address."}
	}
	code, model := bambu.ModelOf(r.Model, serial)
	name := strings.TrimSpace(r.Name)
	if name == "" {
		name = "Bambu Lab " + model.Name
	}
	p := config.Printer{Name: name, Model: code, Serial: serial, IP: ip, AccessCode: strings.TrimSpace(r.AccessCode), MQTTPort: r.MQTTPort, FTPPort: r.FTPPort, Mock: mock}
	t := target(p)
	t.ID = "probe"
	fp, err := bambu.Probe(t)
	if err != nil {
		return config.Printer{}, err
	}
	p.Fingerprint = fp
	p, err = m.store.Add(p)
	if err != nil {
		return config.Printer{}, err
	}
	m.logf("Added %s (%s) at %s.", p.Name, p.Serial, p.IP)
	m.connect(p)
	return p, nil
}

func (m *Manager) addLAN(r addReq, mock bool) (config.Printer, error) {
	if _, ok := kindName[r.Kind]; !ok {
		return config.Printer{}, &bambu.Error{Code: ErrBadRequest, Msg: "That kind of printer is not supported."}
	}
	ip := strings.TrimSpace(r.IP)
	if ip == "" || (net.ParseIP(ip) == nil && strings.ContainsAny(ip, " /\\")) {
		return config.Printer{}, &bambu.Error{Code: ErrBadRequest, Msg: "Enter the printer's IP address or host name."}
	}
	if r.Port < 0 || r.Port > 65535 {
		return config.Printer{}, &bambu.Error{Code: ErrBadRequest, Msg: "That port is not valid."}
	}
	p := config.Printer{Kind: r.Kind, IP: ip, Port: r.Port, TLS: r.TLS, Password: strings.TrimSpace(r.Password), APIKey: strings.TrimSpace(r.APIKey), Mock: mock}
	if r.Kind == lan.Prusa && p.APIKey == "" && p.Password != "" {
		p.Username = strings.TrimSpace(r.Username)
		if p.Username == "" {
			p.Username = "maker"
		}
	}
	if (r.Kind == lan.OctoPrint) && p.APIKey == "" {
		return config.Printer{}, &bambu.Error{Code: ErrBadRequest, Msg: "OctoPrint needs an API key. Create one in OctoPrint under Settings, Application Keys (or API)."}
	}
	t := lanTarget(p)
	t.ID = "probe"
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	info, fp, err := lan.Probe(ctx, t)
	if err != nil {
		return config.Printer{}, err
	}
	p.Fingerprint = fp
	p.Serial = info.Serial
	p.Name = strings.TrimSpace(r.Name)
	if p.Name == "" {
		p.Name = info.Name
	}
	p, err = m.store.Add(p)
	if err != nil {
		return config.Printer{}, err
	}
	m.logf("Added %s (%s) at %s.", p.Name, kindName[p.Kind], p.IP)
	m.connect(p)
	return p, nil
}

// Trust pins the certificate a printer shows now, after checking that it is the one the person looked at.
func (m *Manager) Trust(id, which, fp string) error {
	p, ok := m.store.Printer(id)
	if !ok {
		return &bambu.Error{Code: ErrNotFound, Msg: "No such printer."}
	}
	var seen string
	var err error
	switch {
	case !p.IsBambu():
		which = "http"
		port := p.Port
		if port == 0 {
			port = lan.DefaultPort(p.Kind)
		}
		seen, err = bambu.CertOf(net.JoinHostPort(p.IP, strconv.Itoa(port)), "")
	case which == "ftp":
		seen, err = target(p).FTPCert()
	default:
		which = "mqtt"
		seen, err = target(p).MQTTCert()
	}
	if err != nil {
		return &bambu.Error{Code: bambu.CodeUnreachable, Msg: "Could not reach the printer to read its certificate."}
	}
	if !strings.EqualFold(seen, strings.TrimSpace(fp)) {
		return &bambu.Error{Code: ErrBadRequest, Msg: "The printer is showing a different certificate than the one you looked at. Look again before trusting it."}
	}
	seen = strings.ToLower(seen)
	err = m.store.Update(id, func(x *config.Printer) {
		if which == "ftp" {
			x.FTPFingerprint = seen
		} else {
			x.Fingerprint = seen
		}
	})
	if err != nil {
		return err
	}
	m.logf("Trusted the new certificate of %s.", p.Name)
	if which != "ftp" {
		p, _ = m.store.Printer(id)
		m.connect(p)
	}
	return nil
}

// Remove forgets a printer.
func (m *Manager) Remove(id string) error {
	if err := m.store.Remove(id); err != nil {
		return err
	}
	m.mu.Lock()
	if c, ok := m.clients[id]; ok {
		c.Stop()
		delete(m.clients, id)
	}
	if d, ok := m.drivers[id]; ok {
		d.Stop()
		delete(m.drivers, id)
	}
	delete(m.last, id)
	delete(m.dirty, id)
	delete(m.online, id)
	m.mu.Unlock()
	return nil
}

// Close stops every client.
func (m *Manager) Close() {
	close(m.stop)
	m.mu.Lock()
	for _, c := range m.clients {
		c.Stop()
	}
	for _, d := range m.drivers {
		d.Stop()
	}
	m.mu.Unlock()
}

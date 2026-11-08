package server

import (
	"net"
	"strings"
	"sync"
	"time"

	"github.com/wrathpak/caddy-mccadface/helper/internal/bambu"
	"github.com/wrathpak/caddy-mccadface/helper/internal/config"
)

// Manager holds one MQTT client per stored printer and the latest status of each.
type Manager struct {
	store    *config.Store
	logf     func(string, ...any)
	mu       sync.Mutex
	clients  map[string]*bambu.Client
	last     map[string]bambu.Status
	dirty    map[string]bool
	online   map[string]bool
	OnStatus func(bambu.Status)
	stop     chan struct{}
}

// NewManager makes a manager; Run starts the clients and the status flusher.
func NewManager(store *config.Store, logf func(string, ...any)) *Manager {
	return &Manager{store: store, logf: logf, clients: map[string]*bambu.Client{}, last: map[string]bambu.Status{},
		dirty: map[string]bool{}, online: map[string]bool{}, stop: make(chan struct{})}
}

func target(p config.Printer) bambu.Target {
	return bambu.Target{ID: p.ID, Serial: p.Serial, Host: p.IP, MQTTPort: p.MQTTPort, FTPPort: p.FTPPort, AccessCode: p.AccessCode, Fingerprint: p.Fingerprint}
}

// Info is the printer without its secrets.
func Info(p config.Printer) PrinterInfo {
	code, m := bambu.ModelOf(p.Model, p.Serial)
	return PrinterInfo{ID: p.ID, Name: p.Name, Model: code, ModelName: m.Name, ModelLabel: m.Label, Serial: p.Serial, IP: p.IP,
		Pinned: p.Fingerprint != "", Storage: m.Storage, Mock: p.Mock}
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
	for id := range m.clients {
		if _, ok := m.last[id]; ok {
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

func (m *Manager) connect(p config.Printer) {
	_, model := bambu.ModelOf(p.Model, p.Serial)
	c := bambu.NewClient(target(p), model)
	c.OnPin = func(fp string) {
		_ = m.store.Update(p.ID, func(x *config.Printer) { x.Fingerprint = fp })
		m.logf("Pinned the certificate of %s.", p.Name)
	}
	c.OnChange = func(s bambu.Status) {
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
	m.mu.Lock()
	if old, ok := m.clients[p.ID]; ok {
		old.Stop()
	}
	m.clients[p.ID] = c
	m.mu.Unlock()
	c.Start()
}

// Client returns the live client of a printer.
func (m *Manager) Client(id string) *bambu.Client {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.clients[id]
}

// Statuses returns the latest status of every printer that has one.
func (m *Manager) Statuses() []bambu.Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]bambu.Status, 0, len(m.clients))
	for id, c := range m.clients {
		if s, ok := m.last[id]; ok {
			out = append(out, s)
		} else {
			out = append(out, c.Status())
		}
	}
	return out
}

// Add checks a printer (address, access code, certificate), keeps it and connects to it.
func (m *Manager) Add(r addReq, mock bool) (config.Printer, error) {
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
	m.mu.Unlock()
}

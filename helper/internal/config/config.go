// Package config keeps the printers and the paired browsers on disk, in the user's config folder.
package config

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Printer is one printer the helper keeps. The access code stays in this file and never goes back to the browser.
type Printer struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Model       string `json:"model"`
	Serial      string `json:"serial"`
	IP          string `json:"ip"`
	AccessCode  string `json:"accessCode"`
	MQTTPort    int    `json:"mqttPort,omitempty"`
	FTPPort     int    `json:"ftpPort,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
	// FTPFingerprint is pinned on the first upload: the file server may present its own certificate
	FTPFingerprint string `json:"ftpFingerprint,omitempty"`
	Mock           bool   `json:"mock,omitempty"`

	// Kind is "bambu" (or empty, the first kind there was), "prusa", "klipper" or "octoprint". The kinds other than Bambu are
	// reached over HTTP at IP and Port, with a password (PrusaLink, user Username) or an API key. All of these stay in this file.
	Kind     string `json:"kind,omitempty"`
	Port     int    `json:"port,omitempty"`
	TLS      bool   `json:"tls,omitempty"`
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
	APIKey   string `json:"apiKey,omitempty"`
}

// IsBambu says whether the printer speaks Bambu's LAN protocol.
func (p Printer) IsBambu() bool { return p.Kind == "" || p.Kind == "bambu" }

func (p Printer) same(q Printer) bool {
	if p.IsBambu() != q.IsBambu() {
		return false
	}
	if p.IsBambu() {
		return p.Serial == q.Serial
	}
	return p.Kind == q.Kind && strings.EqualFold(p.IP, q.IP) && p.Port == q.Port
}

// Store reads and writes printers.json and tokens.json.
type Store struct {
	mu       sync.Mutex
	dir      string
	printers []Printer
	tokens   map[string]bool
}

// DefaultDir is os.UserConfigDir()/caddy-link.
func DefaultDir() (string, error) {
	d, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "caddy-link"), nil
}

// Open loads the files in dir (they may not exist yet).
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, tokens: map[string]bool{}}
	var pf struct {
		Printers []Printer `json:"printers"`
	}
	if err := readJSON(filepath.Join(dir, "printers.json"), &pf); err != nil {
		return nil, err
	}
	s.printers = pf.Printers
	var tf struct {
		Tokens []string `json:"tokens"`
	}
	if err := readJSON(filepath.Join(dir, "tokens.json"), &tf); err != nil {
		return nil, err
	}
	for _, t := range tf.Tokens {
		s.tokens[t] = true
	}
	return s, nil
}

func readJSON(path string, v any) error {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s *Store) savePrinters() error {
	return writeJSON(filepath.Join(s.dir, "printers.json"), map[string]any{"printers": s.printers})
}

// Printers returns a copy of the printer list.
func (s *Store) Printers() []Printer {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Printer(nil), s.printers...)
}

// Printer finds one by id.
func (s *Store) Printer(id string) (Printer, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.printers {
		if p.ID == id {
			return p, true
		}
	}
	return Printer{}, false
}

// Add stores a printer and gives it an id. A printer with the same serial (or the same kind, address and port) is replaced.
func (s *Store) Add(p Printer) (Printer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, q := range s.printers {
		if q.same(p) {
			p.ID = q.ID
			s.printers[i] = p
			return p, s.savePrinters()
		}
	}
	p.ID = RandomHex(4)
	s.printers = append(s.printers, p)
	return p, s.savePrinters()
}

// Update changes a stored printer in place.
func (s *Store) Update(id string, fn func(*Printer)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.printers {
		if s.printers[i].ID == id {
			fn(&s.printers[i])
			return s.savePrinters()
		}
	}
	return os.ErrNotExist
}

// Remove deletes a printer.
func (s *Store) Remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, p := range s.printers {
		if p.ID == id {
			s.printers = append(s.printers[:i], s.printers[i+1:]...)
			return s.savePrinters()
		}
	}
	return os.ErrNotExist
}

func hashToken(t string) string {
	h := sha256.Sum256([]byte(t))
	return hex.EncodeToString(h[:])
}

// NewToken makes a long random token for a paired browser and keeps only its hash.
func (s *Store) NewToken() (string, error) {
	t := RandomHex(32)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tokens[hashToken(t)] = true
	list := make([]string, 0, len(s.tokens))
	for h := range s.tokens {
		list = append(list, h)
	}
	return t, writeJSON(filepath.Join(s.dir, "tokens.json"), map[string]any{"tokens": list})
}

// ValidToken says whether t was issued by NewToken.
func (s *Store) ValidToken(t string) bool {
	if t == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tokens[hashToken(t)]
}

// RandomHex is n random bytes as hex.
func RandomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

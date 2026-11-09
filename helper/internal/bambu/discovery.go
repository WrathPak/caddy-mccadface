package bambu

import (
	"net"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Found is a printer that announced itself.
type Found struct {
	// Kind is "bambu", or another kind the app can add ("prusa", "klipper", "octoprint", found over mDNS)
	Kind     string `json:"kind"`
	Port     int    `json:"port,omitempty"`
	Serial   string `json:"serial"`
	Name     string `json:"name"`
	Model    string `json:"model"`
	ModelNm  string `json:"modelName"`
	Label    string `json:"modelLabel"`
	IP       string `json:"ip"`
	MQTTPort int    `json:"mqttPort,omitempty"`
	FTPPort  int    `json:"ftpPort,omitempty"`
	Mock     bool   `json:"mock,omitempty"`
	// AccessCode is only ever set for the built-in mock printer, which has nothing to protect
	AccessCode string `json:"accessCode,omitempty"`
}

const searchTarget = "urn:bambulab-com:device:3dprinter:1"

var msearch = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1990\r\nMAN: \"ssdp:discover\"\r\nMX: 3\r\nST: " + searchTarget + "\r\n\r\n"

var hdr = regexp.MustCompile(`(?im)^([A-Za-z0-9.\-]+):\s*(.*?)\s*$`)

// ParseAnnouncement reads one SSDP NOTIFY or search reply. ok is false for anything that is not a Bambu printer.
func ParseAnnouncement(msg, from string) (f Found, ok bool) {
	if !strings.Contains(strings.ToLower(msg), "bambulab") {
		return f, false
	}
	h := map[string]string{}
	for _, m := range hdr.FindAllStringSubmatch(msg, -1) {
		h[strings.ToLower(m[1])] = m[2]
	}
	f.Kind = "bambu"
	f.Serial = strings.TrimPrefix(h["usn"], "uuid:")
	if f.Serial == "" {
		return f, false
	}
	f.IP = h["location"]
	if net.ParseIP(f.IP) == nil {
		f.IP = from
	}
	f.Name = h["devname.bambu.com"]
	if f.Name == "" {
		f.Name = f.Serial
	}
	code, m := ModelOf(h["devmodel.bambu.com"], f.Serial)
	f.Model, f.ModelNm, f.Label = code, m.Name, m.Label
	return f, true
}

// Discover listens for printer announcements for the given time. Bambu printers broadcast a NOTIFY to UDP 2021 every few
// seconds and also answer an M-SEARCH, so both are used. Another program holding port 2021 (Bambu Studio) only costs the listener.
func Discover(d time.Duration) []Found {
	var mu sync.Mutex
	got := map[string]Found{}
	add := func(msg, from string) {
		if f, ok := ParseAnnouncement(msg, from); ok {
			mu.Lock()
			got[f.Serial] = f
			mu.Unlock()
		}
	}
	deadline := time.Now().Add(d)
	var wg sync.WaitGroup
	read := func(c net.PacketConn) {
		defer wg.Done()
		defer c.Close()
		buf := make([]byte, 4096)
		for {
			c.SetReadDeadline(deadline)
			n, a, err := c.ReadFrom(buf)
			if err != nil {
				return
			}
			host, _, _ := net.SplitHostPort(a.String())
			add(string(buf[:n]), host)
		}
	}
	if l, err := net.ListenPacket("udp4", ":2021"); err == nil {
		wg.Add(1)
		go read(l)
	}
	if s, err := net.ListenPacket("udp4", ":0"); err == nil {
		for _, dst := range []string{"239.255.255.250:1990", "239.255.255.250:2021", "255.255.255.255:2021"} {
			if a, err := net.ResolveUDPAddr("udp4", dst); err == nil {
				s.WriteTo([]byte(msearch), a)
			}
		}
		wg.Add(1)
		go read(s)
	}
	wg.Wait()
	out := make([]Found, 0, len(got))
	for _, f := range got {
		out = append(out, f)
	}
	return out
}

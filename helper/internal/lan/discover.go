package lan

import (
	"context"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/grandcat/zeroconf"

	"github.com/wrathpak/caddy-mccadface/helper/internal/bambu"
)

// Services the printers announce over mDNS: OctoPrint announces _octoprint._tcp, Moonraker _moonraker._tcp (when its
// [zeroconf] component is on), and the Prusa firmware announces _prusalink._tcp (checked in Prusa-Firmware-Buddy,
// lib/WUI/mdns, which registers the "_prusalink" service).
var services = []struct{ typ, kind, label string }{
	{"_prusalink._tcp", Prusa, "PrusaLink"},
	{"_moonraker._tcp", Klipper, "Klipper"},
	{"_octoprint._tcp", OctoPrint, "OctoPrint"},
}

// Discover browses for the three services for d and lists what answered.
func Discover(d time.Duration) []bambu.Found {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	var mu sync.Mutex
	var out []bambu.Found
	seen := map[string]bool{}
	var wg sync.WaitGroup
	for _, sv := range services {
		sv := sv
		res, err := zeroconf.NewResolver(nil)
		if err != nil {
			continue
		}
		ch := make(chan *zeroconf.ServiceEntry, 16)
		wg.Add(2)
		go func() {
			defer wg.Done()
			for e := range ch {
				f, ok := foundOf(sv.kind, sv.label, e)
				if !ok {
					continue
				}
				mu.Lock()
				key := f.Kind + "|" + f.IP + "|" + strconv.Itoa(f.Port)
				if !seen[key] {
					seen[key] = true
					out = append(out, f)
				}
				mu.Unlock()
			}
		}()
		go func() {
			defer wg.Done()
			_ = res.Browse(ctx, sv.typ, "local.", ch) // closes ch when ctx ends
		}()
	}
	wg.Wait()
	if out == nil {
		out = []bambu.Found{}
	}
	return out
}

func foundOf(kind, label string, e *zeroconf.ServiceEntry) (bambu.Found, bool) {
	ip := ""
	if len(e.AddrIPv4) > 0 {
		ip = e.AddrIPv4[0].String()
	} else if len(e.AddrIPv6) > 0 {
		ip = e.AddrIPv6[0].String()
	}
	if ip == "" {
		return bambu.Found{}, false
	}
	name := strings.TrimSpace(e.Instance)
	if name == "" {
		name = label + " at " + ip
	}
	port := e.Port
	if kind == Prusa {
		port = 80 // PrusaLink's web server; the mDNS record names the same port
		if e.Port != 0 {
			port = e.Port
		}
	}
	return bambu.Found{Kind: kind, Name: name, IP: ip, Port: port, ModelNm: label}, true
}

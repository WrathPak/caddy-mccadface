// caddy-link is a small helper that lets the CADdy McCADFace web app talk to printers on your network (Bambu Lab, Prusa, Klipper, OctoPrint).
// Browsers cannot open the raw TLS connections Bambu printers use (MQTT on 8883, FTPS on 990), and PrusaLink sends no CORS
// headers, so this program does the talking and offers the app a WebSocket on 127.0.0.1. It never contacts the internet or Bambu Cloud.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/wrathpak/caddy-mccadface/helper/internal/bambu"
	"github.com/wrathpak/caddy-mccadface/helper/internal/config"
	"github.com/wrathpak/caddy-mccadface/helper/internal/mock"
	"github.com/wrathpak/caddy-mccadface/helper/internal/server"
)

// set at build time with -ldflags "-X main.version=..."
var version = "dev"

type list []string

func (l *list) String() string     { return strings.Join(*l, ",") }
func (l *list) Set(v string) error { *l = append(*l, strings.Split(v, ",")...); return nil }

func main() {
	port := flag.Int("port", 47821, "port to listen on (127.0.0.1 only)")
	dir := flag.String("config-dir", "", "where printers and pairings are kept (default: your user config folder)")
	useMock := flag.Bool("mock", false, "run a built-in fake printer, to try the app without a real one")
	speed := flag.Float64("mock-speed", 1, "how fast the fake printer prints (1 is about a minute per plate)")
	showVersion := flag.Bool("version", false, "print the version and exit")
	var extra list
	flag.Var(&extra, "allow-origin", "also allow this web page origin, such as https://example.com (repeatable)")
	flag.Parse()
	if *showVersion {
		fmt.Println("caddy-link", version)
		return
	}
	logf := func(f string, a ...any) { fmt.Printf("%s  %s\n", time.Now().Format("15:04:05"), fmt.Sprintf(f, a...)) }

	cfgDir := *dir
	if cfgDir == "" {
		d, err := config.DefaultDir()
		if err != nil {
			fatal("Could not find a place to keep settings: %v", err)
		}
		cfgDir = d
	}
	store, err := config.Open(cfgDir)
	if err != nil {
		fatal("Could not read the settings in %s: %v", cfgDir, err)
	}

	opt := server.Options{Version: version, Origins: append(append([]string{}, server.DefaultOrigins...), extra...), Logf: logf}
	var fake *mock.Printer
	var web *mock.Web
	if *useMock {
		fake, err = mock.Start(mock.Options{Speed: *speed})
		if err != nil {
			fatal("Could not start the fake printer: %v", err)
		}
		defer fake.Close()
		web, err = mock.StartWeb(*speed)
		if err != nil {
			fatal("Could not start the fake web printers: %v", err)
		}
		defer web.Close()
		opt.Mocks = append([]bambu.Found{fake.Found()}, web.Found()...)
	}

	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(*port)))
	if err != nil {
		fatal("Could not listen on 127.0.0.1:%d (%v).\nIs CADdy Link already running? Close the other window, or pick another port with --port.", *port, err)
	}
	srv := server.New(store, opt)
	defer srv.Close()

	fmt.Printf("CADdy Link %s\n", version)
	fmt.Println("Lets CADdy McCADFace send prints to your printers (Bambu Lab, Prusa, Klipper, OctoPrint) and show their status.")
	fmt.Println("It only talks to this computer and to printers on your own network, never to the internet.")
	fmt.Println()
	fmt.Printf("Listening on ws://127.0.0.1:%d (this computer only)\n", *port)
	fmt.Printf("Allowed web pages: %s\n", strings.Join(opt.Origins, ", "))
	fmt.Printf("Settings are kept in %s\n", cfgDir)
	if fake != nil {
		f := fake.Found()
		fmt.Printf("Mock printer: %s (%s) with an AMS of 4 trays, access code 12345678, MQTT %d, FTPS %d\n", f.Name, f.Serial, f.MQTTPort, f.FTPPort)
		for _, w := range web.Found() {
			fmt.Printf("Mock %s: %s at 127.0.0.1 port %d\n", w.ModelNm, w.Name, w.Port)
		}
	}
	ps := store.Printers()
	if len(ps) == 0 {
		fmt.Println("Printers: none yet. Add one in the app under Print, Printers.")
	} else {
		fmt.Println("Printers:")
		for _, p := range ps {
			fmt.Printf("  %s at %s (%s)\n", p.Name, p.IP, p.Serial)
		}
	}
	fmt.Println()
	fmt.Printf("Pairing code: %s\n", srv.PairingCode())
	fmt.Println("Type this code in the app the first time you connect. It is not needed again on this browser.")
	fmt.Println()
	fmt.Println("CADdy Link ready. Leave this window open while you print. Press Ctrl+C to quit.")

	hs := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := hs.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fatal("The server stopped: %v", err)
		}
	}()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	fmt.Println("Shutting down.")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = hs.Shutdown(ctx)
}

func fatal(f string, a ...any) {
	fmt.Fprintf(os.Stderr, f+"\n", a...)
	os.Exit(1)
}

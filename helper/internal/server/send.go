package server

import (
	"context"
	"encoding/json"
	"errors"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wrathpak/caddy-mccadface/helper/internal/bambu"
	"github.com/wrathpak/caddy-mccadface/helper/internal/config"
	"github.com/wrathpak/caddy-mccadface/helper/internal/lan"
)

const maxFile = 512 << 20

// job is one file coming from the browser and going to a printer.
type job struct {
	id      string
	printer config.Printer
	opt     sendBegin
	name    string
	buf     []byte
	cancel  context.CancelFunc
	ctx     context.Context
	done    bool
	// stage is receiving (from the browser), uploading (to the printer) or starting (the print command is out: too late to cancel)
	stage string
	last  time.Time
	mu    sync.Mutex
}

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

func cleanName(n string) string {
	n = path.Base(strings.ReplaceAll(n, "\\", "/"))
	n = strings.Trim(unsafeName.ReplaceAllString(n, "_"), "._")
	if len(n) > 80 {
		n = n[len(n)-80:]
	}
	return n
}

// remoteName is the file name a Bambu printer stores: plain characters, ending in .gcode.3mf or .3mf.
func remoteName(n string) string {
	n = cleanName(n)
	if !strings.HasSuffix(strings.ToLower(n), ".3mf") {
		n += ".gcode.3mf"
	}
	if n == "" || n[0] == '.' {
		n = "caddy" + n
	}
	return n
}

// gcodeName is the file name for the other kinds: plain characters, ending in .gcode.
func gcodeName(n string) string {
	n = cleanName(n)
	if !strings.HasSuffix(strings.ToLower(n), ".gcode") {
		n += ".gcode"
	}
	if n[0] == '.' {
		n = "caddy" + n
	}
	return n
}

func (c *conn) event(j *job, stage string, sent, total int64, code, msg string) {
	c.write(marshal(sendEvent{Type: "send", JobID: j.id, PrinterID: j.printer.ID, Stage: stage, Sent: sent, Total: total, Code: code, Message: msg}))
}

func (c *conn) fault(j *job, total int64, err error) {
	code, msg := bambu.CodeUpload, err.Error()
	var e *bambu.Error
	ev := sendEvent{Type: "send", JobID: j.id, PrinterID: j.printer.ID, Stage: "error", Total: total}
	if errors.As(err, &e) {
		code, ev.OldFingerprint, ev.NewFingerprint = e.Code, e.Old, e.New
	}
	ev.Code, ev.Message = code, msg
	c.write(marshal(ev))
}

func (c *conn) sendBegin(id string, data []byte) {
	var r sendBegin
	if json.Unmarshal(data, &r) != nil || r.Size <= 0 || r.Size > maxFile || r.FileName == "" {
		c.fail(id, ErrBadRequest, "That file is empty or too big to send.")
		return
	}
	p, ok := c.s.store.Printer(r.PrinterID)
	ctl := c.s.mgr.Controller(r.PrinterID)
	if !ok || ctl == nil {
		c.fail(id, ErrNotFound, "No such printer.")
		return
	}
	st := ctl.Status()
	switch {
	case !st.Online:
		c.fail(id, bambu.CodeOffline, p.Name+" is offline.")
		return
	case ctl.Busy():
		c.fail(id, bambu.CodeBusy, p.Name+" is already printing. Wait for it to finish, or stop it first.")
		return
	case p.IsBambu() && st.SDCard != nil && !*st.SDCard:
		c.fail(id, bambu.CodeSDMissing, p.Name+" has no storage card. Put a card in the printer, then send again.")
		return
	}
	c.jm.Lock()
	if c.job != nil && !c.job.done {
		c.jm.Unlock()
		c.fail(id, bambu.CodeBusy, "A file is already being sent.")
		return
	}
	// not tied to the connection: an upload under way finishes if the browser goes away (dropJob ends one still receiving)
	ctx, cancel := context.WithCancel(context.Background())
	name := remoteName(r.FileName)
	if !p.IsBambu() {
		name = gcodeName(r.FileName)
	}
	j := &job{id: config.RandomHex(6), printer: p, opt: r, name: name, buf: make([]byte, 0, r.Size), ctx: ctx, cancel: cancel, stage: "receiving"}
	c.job = j
	c.jm.Unlock()
	c.reply(id, map[string]any{"jobId": j.id})
	c.s.opt.Logf("Receiving %s for %s (%.1f MB).", j.name, p.Name, float64(r.Size)/1048576)
	c.event(j, "receiving", 0, r.Size, "", "")
}

func (c *conn) onBinary(b []byte) {
	c.jm.Lock()
	j := c.job
	c.jm.Unlock()
	if j == nil || !c.isAuthed() {
		return
	}
	j.mu.Lock()
	if j.done || j.stage != "receiving" || int64(len(j.buf)) >= j.opt.Size {
		j.mu.Unlock()
		return
	}
	j.buf = append(j.buf, b...)
	n := int64(len(j.buf))
	over := n > j.opt.Size
	complete := n == j.opt.Size
	tick := time.Since(j.last) > 200*time.Millisecond
	if tick {
		j.last = time.Now()
	}
	if over {
		j.done = true
	}
	if complete {
		j.stage = "uploading"
	}
	j.mu.Unlock()
	switch {
	case over:
		c.event(j, "error", n, j.opt.Size, ErrBadRequest, "More data arrived than the file size said.")
		j.cancel()
	case complete:
		go c.run(j)
	case tick:
		c.event(j, "receiving", n, j.opt.Size, "", "")
	}
}

// cancelJob stops a send: while the file is still arriving from the browser, and also while it is going to the printer (the
// upload is aborted and, on a Bambu printer, the partial file is deleted). Once the print command is out it is too late.
func (c *conn) cancelJob(id string) error {
	c.jm.Lock()
	j := c.job
	c.jm.Unlock()
	if j == nil || j.id != id {
		return nil
	}
	j.mu.Lock()
	stage := j.stage
	if j.done {
		j.mu.Unlock()
		return nil
	}
	switch stage {
	case "receiving":
		j.done = true
		n := int64(len(j.buf))
		j.mu.Unlock()
		j.cancel()
		c.event(j, "cancelled", n, j.opt.Size, "", "")
		return nil
	case "uploading":
		j.mu.Unlock()
		j.cancel() // run() sees it, cleans up and says "cancelled"
		return nil
	}
	j.mu.Unlock()
	return &bambu.Error{Code: bambu.CodeBusy, Msg: "The print is already starting. Use Stop on the printer instead."}
}

// dropJob ends a job that is still receiving when the browser goes away. An upload already under way finishes.
func (c *conn) dropJob() {
	c.jm.Lock()
	j := c.job
	c.jm.Unlock()
	if j == nil {
		return
	}
	j.mu.Lock()
	receiving := !j.done && j.stage == "receiving"
	j.mu.Unlock()
	if receiving {
		j.cancel()
	}
}

// cancelled ends a job that was canceled while uploading: the printer's partial file goes, and the app is told.
func (c *conn) cancelled(j *job, total int64) {
	if j.printer.IsBambu() {
		t := target(j.printer)
		t.Fingerprint = j.printer.FTPFingerprint
		if err := bambu.RemoveFile(t, j.name, j.printer.FTPFingerprint); err != nil {
			c.s.opt.Logf("Could not remove the partial file %s from %s: %v", j.name, j.printer.Name, err)
		}
	}
	c.s.opt.Logf("Upload to %s cancelled.", j.printer.Name)
	c.event(j, "cancelled", 0, total, "", "")
}

// run uploads the file to the printer and starts it.
func (c *conn) run(j *job) {
	defer func() {
		j.mu.Lock()
		j.done = true
		j.buf = nil
		j.mu.Unlock()
	}()
	if j.printer.IsBambu() {
		c.runBambu(j)
	} else {
		c.runLAN(j)
	}
}

func (c *conn) runLAN(j *job) {
	s := c.s
	p := j.printer
	total := j.opt.Size
	d := s.mgr.Driver(p.ID)
	if d == nil {
		c.event(j, "error", 0, total, bambu.CodeOffline, "The printer was removed.")
		return
	}
	c.event(j, "uploading", 0, total, "", "")
	s.opt.Logf("Uploading %s to %s.", j.name, p.Name)
	err := d.Send(j.ctx, j.name, j.buf, lan.SendOptions{Storage: j.opt.Storage}, func(sent int64) { c.event(j, "uploading", sent, total, "", "") })
	if err != nil {
		var e *bambu.Error
		if j.ctx.Err() != nil || (errors.As(err, &e) && e.Code == bambu.CodeCancelled) {
			c.cancelled(j, total)
			return
		}
		s.opt.Logf("Sending to %s failed: %s", p.Name, err.Error())
		c.fault(j, total, err)
		return
	}
	j.mu.Lock()
	j.stage = "starting"
	j.mu.Unlock()
	s.opt.Logf("%s started %s.", p.Name, j.name)
	c.event(j, "done", total, total, "", "")
}

func (c *conn) runBambu(j *job) {
	s := c.s
	p := j.printer
	total := j.opt.Size
	_, model := bambu.ModelOf(p.Model, p.Serial)
	t := target(p)
	t.Fingerprint = p.FTPFingerprint
	c.event(j, "uploading", 0, total, "", "")
	s.opt.Logf("Uploading %s to %s.", j.name, p.Name)
	data := j.buf
	err := bambu.Upload(j.ctx, t, model, j.name, data, func(sent int64) { c.event(j, "uploading", sent, total, "", "") }, p.FTPFingerprint, func(fp string) {
		if p.FTPFingerprint == "" {
			p.FTPFingerprint = fp
			_ = s.store.Update(p.ID, func(x *config.Printer) {
				if x.FTPFingerprint == "" {
					x.FTPFingerprint = fp
				}
			})
		}
	})
	if err != nil {
		var e *bambu.Error
		if j.ctx.Err() != nil || (errors.As(err, &e) && e.Code == bambu.CodeCancelled) {
			c.cancelled(j, total)
			return
		}
		s.opt.Logf("Upload to %s failed: %s", p.Name, err.Error())
		c.fault(j, total, err)
		return
	}
	// a cancel that came in as the last bytes went out still counts
	j.mu.Lock()
	stop := j.ctx.Err() != nil
	if !stop {
		j.stage = "starting"
	}
	j.mu.Unlock()
	if stop {
		c.cancelled(j, total)
		return
	}
	c.event(j, "starting", total, total, "", "")
	cl := s.mgr.Client(p.ID)
	if cl == nil {
		c.event(j, "error", total, total, bambu.CodeOffline, "The printer was removed.")
		return
	}
	err = cl.StartPrint(bambu.StartOptions{File: j.name, UseAMS: j.opt.UseAMS, AMSMapping: j.opt.AMSMapping,
		BedLeveling: j.opt.BedLeveling, FlowCali: j.opt.FlowCali, Timelapse: j.opt.Timelapse})
	if err != nil {
		s.opt.Logf("%s would not start the print: %s", p.Name, err.Error())
		c.fault(j, total, err)
		return
	}
	s.opt.Logf("%s started %s.", p.Name, j.name)
	c.event(j, "done", total, total, "", "")
}

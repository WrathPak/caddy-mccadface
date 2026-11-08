package server

import (
	"context"
	"encoding/json"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wrathpak/caddy-mccadface/helper/internal/bambu"
	"github.com/wrathpak/caddy-mccadface/helper/internal/config"
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
	last    time.Time
	mu      sync.Mutex
}

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// remoteName is the file name the printer stores: plain characters, ending in .gcode.3mf or .3mf.
func remoteName(n string) string {
	n = path.Base(strings.ReplaceAll(n, "\\", "/"))
	n = strings.Trim(unsafeName.ReplaceAllString(n, "_"), "._")
	if len(n) > 80 {
		n = n[len(n)-80:]
	}
	if !strings.HasSuffix(strings.ToLower(n), ".3mf") {
		n += ".gcode.3mf"
	}
	if n == "" || n[0] == '.' {
		n = "caddy" + n
	}
	return n
}

func (c *conn) event(j *job, stage string, sent, total int64, code, msg string) {
	c.write(marshal(sendEvent{Type: "send", JobID: j.id, PrinterID: j.printer.ID, Stage: stage, Sent: sent, Total: total, Code: code, Message: msg}))
}

func (c *conn) sendBegin(id string, data []byte) {
	var r sendBegin
	if json.Unmarshal(data, &r) != nil || r.Size <= 0 || r.Size > maxFile || r.FileName == "" {
		c.fail(id, ErrBadRequest, "That file is empty or too big to send.")
		return
	}
	p, ok := c.s.store.Printer(r.PrinterID)
	if !ok {
		c.fail(id, ErrNotFound, "No such printer.")
		return
	}
	cl := c.s.mgr.Client(p.ID)
	if cl == nil {
		c.fail(id, ErrNotFound, "No such printer.")
		return
	}
	st := cl.Status()
	switch {
	case !st.Online:
		c.fail(id, bambu.CodeOffline, p.Name+" is offline.")
		return
	case cl.Busy():
		c.fail(id, bambu.CodeBusy, p.Name+" is already printing. Wait for it to finish, or stop it first.")
		return
	case st.SDCard != nil && !*st.SDCard:
		c.fail(id, bambu.CodeSDMissing, p.Name+" has no storage card. Put a card in the printer, then send again.")
		return
	}
	c.jm.Lock()
	if c.job != nil && !c.job.done {
		c.jm.Unlock()
		c.fail(id, bambu.CodeBusy, "A file is already being sent.")
		return
	}
	ctx, cancel := context.WithCancel(c.ctx)
	j := &job{id: config.RandomHex(6), printer: p, opt: r, name: remoteName(r.FileName), buf: make([]byte, 0, r.Size), ctx: ctx, cancel: cancel}
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
	if j.done || int64(len(j.buf)) >= j.opt.Size {
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

func (c *conn) cancelJob(id string) {
	c.jm.Lock()
	j := c.job
	c.jm.Unlock()
	if j == nil || j.id != id {
		return
	}
	j.mu.Lock()
	receiving := !j.done && int64(len(j.buf)) < j.opt.Size
	if receiving {
		j.done = true
	}
	j.mu.Unlock()
	if receiving {
		j.cancel()
		c.event(j, "cancelled", int64(len(j.buf)), j.opt.Size, "", "")
	}
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
	receiving := !j.done && int64(len(j.buf)) < j.opt.Size
	j.mu.Unlock()
	if receiving {
		j.cancel()
	}
}

// run uploads the file to the printer and starts it.
func (c *conn) run(j *job) {
	defer func() {
		j.mu.Lock()
		j.done = true
		j.buf = nil
		j.mu.Unlock()
	}()
	s := c.s
	p := j.printer
	total := j.opt.Size
	_, model := bambu.ModelOf(p.Model, p.Serial)
	t := target(p)
	t.Fingerprint = p.FTPFingerprint
	c.event(j, "uploading", 0, total, "", "")
	s.opt.Logf("Uploading %s to %s.", j.name, p.Name)
	data := j.buf
	err := bambu.Upload(t, model, j.name, data, func(sent int64) { c.event(j, "uploading", sent, total, "", "") }, p.FTPFingerprint, func(fp string) {
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
		code, msg := bambu.CodeUpload, err.Error()
		if e, ok := err.(*bambu.Error); ok {
			code = e.Code
		}
		s.opt.Logf("Upload to %s failed: %s", p.Name, msg)
		c.event(j, "error", 0, total, code, msg)
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
		code, msg := bambu.CodeRejected, err.Error()
		if e, ok := err.(*bambu.Error); ok {
			code = e.Code
		}
		s.opt.Logf("%s would not start the print: %s", p.Name, msg)
		c.event(j, "error", total, total, code, msg)
		return
	}
	s.opt.Logf("%s started %s.", p.Name, j.name)
	c.event(j, "done", total, total, "", "")
}

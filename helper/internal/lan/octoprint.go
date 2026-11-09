package lan

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/wrathpak/caddy-mccadface/helper/internal/bambu"
)

// OctoPrint: an API key in X-Api-Key; status from /api/job and /api/printer; the job commands are POST /api/job; the file goes
// to POST /api/files/local with select and print set.
type octo struct{ *base }

func probeOcto(ctx context.Context, c *Client) (Info, error) {
	// /api/job needs the key, so it tells a wrong key from a missing one
	if _, _, err := getJSON(ctx, c, "/api/job"); err != nil {
		return Info{}, err
	}
	return Info{Name: "OctoPrint"}, nil
}

func (o *octo) Start() { go o.loop(o.poll) }

func (o *octo) poll(ctx context.Context) (bambu.Status, error) {
	j, _, err := getJSON(ctx, o.c, "/api/job")
	if err != nil {
		return bambu.Status{}, err
	}
	st := blank(o.t)
	text := strings.TrimSpace(s(j["state"]))
	st.GcodeState = text
	prog := sub(j, "progress")
	st.Percent = pct(fOr(prog["completion"], 0))
	st.RemainMin = minutes(fOr(prog["printTimeLeft"], 0))
	if f := sub(j, "job", "file"); f != nil {
		st.File = s(f["display"])
		if st.File == "" {
			st.File = s(f["name"])
		}
	}
	low := strings.ToLower(text)
	switch {
	case strings.HasPrefix(low, "printing"), low == "starting", low == "sending file to sd":
		st.State = "running"
	case low == "paused", low == "pausing", strings.HasPrefix(low, "paused"):
		st.State = "pause"
	case low == "cancelling", low == "finishing", low == "resuming", strings.Contains(low, "connecting"), strings.Contains(low, "detecting"):
		st.State = "prepare"
	case low == "operational":
		st.State = "idle"
		if st.Percent >= 100 && st.File != "" {
			st.State = "finish"
		} else {
			st.Percent = 0
		}
	case strings.HasPrefix(low, "error"), strings.Contains(low, "after error"):
		st.State = "failed"
		st.PrintErrTxt = text
	case low == "offline", low == "closed", strings.HasPrefix(low, "offline"):
		st.Problem = &bambu.Problem{Code: CodeNoPrinter, Message: "OctoPrint is running, but it is not connected to the printer. Connect it in OctoPrint, then try again."}
	}
	// temperatures only exist while the printer is connected
	if r, err := o.c.Bytes(ctx, http.MethodGet, "/api/printer", nil, nil); err == nil && r.Status == http.StatusOK {
		var p obj
		if json.Unmarshal(r.Body, &p) == nil {
			t := sub(p, "temperature")
			tool := sub(t, "tool0")
			st.Nozzle = bambu.Temp{Cur: fOr(tool["actual"], 0), Target: fOr(tool["target"], 0)}
			bed := sub(t, "bed")
			st.Bed = bambu.Temp{Cur: fOr(bed["actual"], 0), Target: fOr(bed["target"], 0)}
			if c := sub(t, "chamber"); c != nil {
				st.Chamber = &bambu.Temp{Cur: fOr(c["actual"], 0), Target: fOr(c["target"], 0)}
			}
		}
	}
	return st, nil
}

func (o *octo) command(body obj) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	b, _ := json.Marshal(body)
	r, err := o.c.Bytes(ctx, http.MethodPost, "/api/job", map[string]string{"Content-Type": "application/json"}, b)
	if err != nil {
		return Explain(o.t, err)
	}
	if r.Status/100 != 2 {
		if r.Status == http.StatusConflict {
			return &bambu.Error{Code: bambu.CodeBusy, Msg: "OctoPrint cannot do that right now. " + snippet(r.Body)}
		}
		return statusError("Job command", r)
	}
	return nil
}

func (o *octo) Pause() error  { return o.command(obj{"command": "pause", "action": "pause"}) }
func (o *octo) Resume() error { return o.command(obj{"command": "pause", "action": "resume"}) }
func (o *octo) Cancel() error { return o.command(obj{"command": "cancel"}) }

func (o *octo) Send(ctx context.Context, name string, data []byte, _ SendOptions, progress func(int64)) error {
	head, tail, ctype := multipartForm([][2]string{{"select", "true"}, {"print", "true"}}, "file", name)
	r, err := o.upload(ctx, http.MethodPost, "/api/files/local", map[string]string{"Content-Type": ctype}, head, data, tail, progress)
	if err != nil {
		return Explain(o.t, err)
	}
	if r.Status != http.StatusCreated && r.Status != http.StatusOK {
		return statusError("Upload", r)
	}
	return nil
}

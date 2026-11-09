package lan

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wrathpak/caddy-mccadface/helper/internal/bambu"
)

// PrusaLink, as described by Prusa's OpenAPI spec (Prusa-Link-Web, spec/openapi.yaml): digest authentication (user maker, or
// the user set on the printer) or an X-Api-Key, status at /api/v1/status and /api/v1/job, files at /api/v1/files/{storage}/{path}.
type prusa struct {
	*base
	mu      sync.Mutex
	jobID   int
	file    string
	fileJob int
}

func getJSON(ctx context.Context, c *Client, path string) (obj, *Reply, error) {
	r, err := c.Bytes(ctx, http.MethodGet, path, map[string]string{"Accept": "application/json"}, nil)
	if err != nil {
		return nil, nil, err
	}
	if r.Status == http.StatusNoContent {
		return obj{}, r, nil
	}
	if r.Status != http.StatusOK {
		return nil, r, statusError("GET "+path, r)
	}
	var m obj
	if err := json.Unmarshal(r.Body, &m); err != nil {
		return nil, r, &bambu.Error{Code: bambu.CodeUnreachable, Msg: "That address did not answer like a printer. Check the printer kind and port."}
	}
	return m, r, nil
}

func probePrusa(ctx context.Context, c *Client) (Info, error) {
	if _, _, err := getJSON(ctx, c, "/api/v1/status"); err != nil {
		return Info{}, err
	}
	in := Info{Name: "Prusa printer"}
	if m, _, err := getJSON(ctx, c, "/api/v1/info"); err == nil {
		if n := strings.TrimSpace(s(m["name"])); n != "" {
			in.Name = n
		} else if h := strings.TrimSpace(s(m["hostname"])); h != "" {
			in.Name = h
		}
		in.Serial = s(m["serial"])
	}
	return in, nil
}

func (p *prusa) Start() { go p.loop(p.poll) }

var prusaState = map[string]string{
	"IDLE": "idle", "READY": "idle", "BUSY": "prepare", "PRINTING": "running", "PAUSED": "pause", "ATTENTION": "pause",
	"FINISHED": "finish", "STOPPED": "stopped", "ERROR": "failed",
}

func (p *prusa) poll(ctx context.Context) (bambu.Status, error) {
	m, _, err := getJSON(ctx, p.c, "/api/v1/status")
	if err != nil {
		return bambu.Status{}, err
	}
	st := blank(p.t)
	pr := sub(m, "printer")
	raw := strings.ToUpper(s(pr["state"]))
	st.GcodeState = raw
	if v, ok := prusaState[raw]; ok {
		st.State = v
	}
	st.Nozzle = bambu.Temp{Cur: fOr(pr["temp_nozzle"], 0), Target: fOr(pr["target_nozzle"], 0)}
	st.Bed = bambu.Temp{Cur: fOr(pr["temp_bed"], 0), Target: fOr(pr["target_bed"], 0)}
	if v, ok := f64(pr["speed"]); ok {
		n := int(v)
		st.SpeedPct = &n
	}
	// the fans are reported in rpm, so they are readouts and not percents
	add := func(label, value string) {
		st.Readouts = append(st.Readouts, bambu.Readout{Label: label, Value: value})
	}
	if v, ok := f64(pr["fan_print"]); ok {
		add("Print fan", fmt.Sprintf("%d rpm", int(v)))
	}
	if v, ok := f64(pr["fan_hotend"]); ok {
		add("Hotend fan", fmt.Sprintf("%d rpm", int(v)))
	}
	if v, ok := f64(pr["flow"]); ok {
		add("Flow", fmt.Sprintf("%d%%", int(v)))
	}
	if v, ok := f64(pr["axis_z"]); ok {
		add("Height", fmt.Sprintf("%.2f mm", v))
	}
	if sp := sub(pr, "status_printer"); sp != nil {
		if ok, _ := sp["ok"].(bool); !ok {
			st.PrintErrTxt = strings.TrimSpace(s(sp["message"]))
		}
	}
	if raw == "ERROR" && st.PrintErrTxt == "" {
		st.PrintErrTxt = "The printer reports an error. Look at its screen."
	}
	if raw == "ATTENTION" && st.PrintErrTxt == "" {
		st.PrintErrTxt = "The printer needs attention. Look at its screen."
	}
	job := sub(m, "job")
	if job != nil {
		st.Percent = pct(fOr(job["progress"], 0))
		st.RemainMin = minutes(fOr(job["time_remaining"], 0))
		id := int(fOr(job["id"], 0))
		p.mu.Lock()
		p.jobID = id
		known := p.fileJob == id && p.file != ""
		p.mu.Unlock()
		if !known {
			if j, _, err := getJSON(ctx, p.c, "/api/v1/job"); err == nil {
				if f := sub(j, "file"); f != nil {
					name := s(f["display_name"])
					if name == "" {
						name = s(f["name"])
					}
					p.mu.Lock()
					p.file, p.fileJob = name, id
					p.mu.Unlock()
				}
			}
		}
	} else if st.State == "idle" {
		st.Percent = 0
	}
	p.mu.Lock()
	if st.State != "idle" {
		st.File = p.file
	}
	p.mu.Unlock()
	if st.State == "finish" && st.Percent == 0 {
		st.Percent = 100
	}
	return st, nil
}

// jobID is the id of the job to pause, resume or stop: the one the last status named, or the one the printer names now.
func (p *prusa) currentJob(ctx context.Context) (int, error) {
	p.mu.Lock()
	id := p.jobID
	p.mu.Unlock()
	if id > 0 {
		return id, nil
	}
	j, _, err := getJSON(ctx, p.c, "/api/v1/job")
	if err != nil {
		return 0, err
	}
	if id = int(fOr(j["id"], 0)); id <= 0 {
		return 0, &bambu.Error{Code: bambu.CodeBusy, Msg: "There is no print to control."}
	}
	return id, nil
}

func (p *prusa) jobCall(method, suffix string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	id, err := p.currentJob(ctx)
	if err != nil {
		return err
	}
	r, err := p.c.Bytes(ctx, method, "/api/v1/job/"+strconv.Itoa(id)+suffix, nil, nil)
	if err != nil {
		return Explain(p.t, err)
	}
	if r.Status/100 != 2 {
		if r.Status == http.StatusConflict {
			return &bambu.Error{Code: bambu.CodeBusy, Msg: "The printer cannot do that right now (it is in another state)."}
		}
		return statusError("Job command", r)
	}
	return nil
}

// Pause and resume are PUT .../job/{id}/pause and .../resume; stop is DELETE .../job/{id}.
func (p *prusa) Pause() error  { return p.jobCall(http.MethodPut, "/pause") }
func (p *prusa) Resume() error { return p.jobCall(http.MethodPut, "/resume") }
func (p *prusa) Cancel() error { return p.jobCall(http.MethodDelete, "") }

// Storages lists where files can go, for the app's choice: the storage names PrusaLink reports that are ready and writable.
func (p *prusa) storage(ctx context.Context, want string) (string, error) {
	m, _, err := getJSON(ctx, p.c, "/api/v1/storage")
	if err != nil {
		return "", err
	}
	list, _ := m["storage_list"].([]any)
	first := ""
	for _, e := range list {
		sm, _ := e.(obj)
		if sm == nil {
			continue
		}
		path := strings.Trim(s(sm["path"]), "/")
		if ok, _ := sm["available"].(bool); !ok {
			continue
		}
		if ro, _ := sm["read_only"].(bool); ro {
			continue
		}
		if want != "" && strings.Trim(want, "/") == path {
			return path, nil
		}
		if first == "" {
			first = path
		}
	}
	if want != "" {
		return "", &bambu.Error{Code: bambu.CodeSDMissing, Msg: "That storage on the printer is not ready. Insert the USB drive or pick another place."}
	}
	if first == "" {
		return "", &bambu.Error{Code: bambu.CodeSDMissing, Msg: "The printer has no storage that is ready. Insert a USB drive and try again."}
	}
	return first, nil
}

// Send is PUT /api/v1/files/{storage}/{path} with Print-After-Upload: ?1.
func (p *prusa) Send(ctx context.Context, name string, data []byte, o SendOptions, progress func(int64)) error {
	p.c.Prime(ctx, "/api/v1/status")
	storage, err := p.storage(ctx, o.Storage)
	if err != nil {
		return Explain(p.t, err)
	}
	hdr := map[string]string{"Content-Type": "application/octet-stream", "Print-After-Upload": "?1", "Overwrite": "?1"}
	r, err := p.upload(ctx, http.MethodPut, "/api/v1/files/"+storage+"/"+escapePath(name), hdr, nil, data, nil, progress)
	if err != nil {
		return Explain(p.t, err)
	}
	if r.Status != http.StatusCreated && r.Status != http.StatusOK && r.Status != http.StatusNoContent {
		return statusError("Upload", r)
	}
	return nil
}

package bambu

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// Status is what the app sees of a printer. The JSON names match src/features/print/link/protocol.ts.
type Status struct {
	PrinterID   string   `json:"printerId"`
	Online      bool     `json:"online"`
	Problem     *Problem `json:"problem"`
	State       string   `json:"state"`
	GcodeState  string   `json:"gcodeState"`
	Percent     int      `json:"percent"`
	RemainMin   int      `json:"remainingMin"`
	Layer       int      `json:"layer"`
	TotalLayers int      `json:"totalLayers"`
	File        string   `json:"file"`
	Nozzle      Temp     `json:"nozzle"`
	Bed         Temp     `json:"bed"`
	Chamber     *Temp    `json:"chamber"`
	Fans        Fans     `json:"fans"`
	SpeedLevel  int      `json:"speedLevel"`
	Light       *bool    `json:"light"`
	AMS         AMS      `json:"ams"`
	HMS         []HMS    `json:"hms"`
	PrintError  string   `json:"printError"`
	PrintErrTxt string   `json:"printErrorText"`
	Wifi        *int     `json:"wifi"`
	SDCard      *bool    `json:"sdcard"`
	UpdatedAt   int64    `json:"updatedAt"`
}

// Problem is a reason the live numbers are not shown.
type Problem struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Temp struct {
	Cur    float64 `json:"cur"`
	Target float64 `json:"target"`
}

type Fans struct {
	Part    int `json:"part"`
	Aux     int `json:"aux"`
	Chamber int `json:"chamber"`
}

type AMS struct {
	Units    []Unit `json:"units"`
	External *Tray  `json:"external"`
	Active   *int   `json:"active"`
}

type Unit struct {
	ID          int      `json:"id"`
	Humidity    int      `json:"humidity"`
	HumidityPct *int     `json:"humidityPct"`
	Temp        *float64 `json:"temp"`
	Trays       []Tray   `json:"trays"`
}

type Tray struct {
	ID     int     `json:"id"`
	Slot   int     `json:"slot"`
	Type   string  `json:"type"`
	Color  *string `json:"color"`
	Remain int     `json:"remain"`
	Name   string  `json:"name"`
	Empty  bool    `json:"empty"`
}

type HMS struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Text     string `json:"text"`
}

// Merge folds a report into the full state. P1 and A1 printers send only what changed, so objects merge key by key,
// and lists of objects with an id (the AMS units and their trays) merge by id.
func Merge(dst, src map[string]any) {
	for k, v := range src {
		switch sv := v.(type) {
		case map[string]any:
			if dv, ok := dst[k].(map[string]any); ok {
				Merge(dv, sv)
			} else {
				dst[k] = sv
			}
		case []any:
			dv, ok := dst[k].([]any)
			if ok && keyed(dv) && keyed(sv) {
				dst[k] = mergeList(dv, sv)
			} else {
				dst[k] = sv
			}
		default:
			dst[k] = v
		}
	}
}

func keyed(l []any) bool {
	if len(l) == 0 {
		return false
	}
	for _, e := range l {
		m, ok := e.(map[string]any)
		if !ok {
			return false
		}
		if _, ok := m["id"]; !ok {
			return false
		}
	}
	return true
}

func mergeList(dst, src []any) []any {
	out := append([]any(nil), dst...)
	for _, e := range src {
		em := e.(map[string]any)
		hit := false
		for i, d := range out {
			dm := d.(map[string]any)
			if fmt.Sprint(dm["id"]) == fmt.Sprint(em["id"]) {
				Merge(dm, em)
				out[i] = dm
				hit = true
				break
			}
		}
		if !hit {
			out = append(out, em)
		}
	}
	return out
}

func num(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return f, err == nil
	}
	return 0, false
}

func numOr(v any, def float64) float64 {
	if f, ok := num(v); ok {
		return f
	}
	return def
}

func str(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	return ""
}

// gear is a fan speed the printer reports as 0 to 15, as a percent.
func gear(v any) int {
	f, ok := num(v)
	if !ok {
		return 0
	}
	return int(math.Round(f / 15 * 100))
}

func states(s string) string {
	switch strings.ToUpper(s) {
	case "IDLE":
		return "idle"
	case "PREPARE", "SLICING":
		return "prepare"
	case "RUNNING":
		return "running"
	case "PAUSE":
		return "pause"
	case "FINISH":
		return "finish"
	case "FAILED":
		return "failed"
	}
	return "unknown"
}

func tray(m map[string]any, unit, id int, ht bool) Tray {
	t := Tray{ID: unit*4 + id, Slot: id, Remain: -1}
	if ht {
		t.ID, t.Slot = unit, 0
	}
	t.Type = strings.TrimSpace(str(m["tray_type"]))
	t.Name = strings.TrimSpace(str(m["tray_sub_brands"]))
	if r, ok := num(m["remain"]); ok && r >= 0 && r <= 100 {
		t.Remain = int(r)
	}
	c := strings.TrimSpace(str(m["tray_color"]))
	if len(c) >= 6 && t.Type != "" {
		h := "#" + strings.ToUpper(c[:6])
		t.Color = &h
	}
	t.Empty = t.Type == ""
	return t
}

// Normalize turns the merged raw state of a printer into a Status.
func Normalize(printerID string, online bool, raw map[string]any) Status {
	s := Status{PrinterID: printerID, Online: online, State: "unknown", HMS: []HMS{}, AMS: AMS{Units: []Unit{}}, UpdatedAt: time.Now().UnixMilli()}
	s.GcodeState = str(raw["gcode_state"])
	s.State = states(s.GcodeState)
	s.Percent = int(numOr(raw["mc_percent"], 0))
	s.RemainMin = int(numOr(raw["mc_remaining_time"], 0))
	s.Layer = int(numOr(raw["layer_num"], 0))
	s.TotalLayers = int(numOr(raw["total_layer_num"], 0))
	s.File = str(raw["subtask_name"])
	if s.File == "" {
		g := str(raw["gcode_file"])
		s.File = g[strings.LastIndexAny(g, "/\\")+1:]
	}
	s.Nozzle = Temp{numOr(raw["nozzle_temper"], 0), numOr(raw["nozzle_target_temper"], 0)}
	s.Bed = Temp{numOr(raw["bed_temper"], 0), numOr(raw["bed_target_temper"], 0)}
	if _, ok := num(raw["chamber_temper"]); ok {
		s.Chamber = &Temp{numOr(raw["chamber_temper"], 0), numOr(raw["ctt"], 0)}
	}
	s.Fans = Fans{Part: gear(raw["cooling_fan_speed"]), Aux: gear(raw["big_fan1_speed"]), Chamber: gear(raw["big_fan2_speed"])}
	s.SpeedLevel = int(numOr(raw["spd_lvl"], 2))
	if l, ok := raw["lights_report"].([]any); ok {
		for _, e := range l {
			if m, ok := e.(map[string]any); ok && str(m["node"]) == "chamber_light" {
				on := str(m["mode"]) == "on"
				s.Light = &on
			}
		}
	}
	if w := strings.TrimSuffix(strings.TrimSpace(str(raw["wifi_signal"])), "dBm"); w != "" {
		if f, ok := num(w); ok {
			v := int(f)
			s.Wifi = &v
		}
	}
	if sd, ok := raw["sdcard"].(bool); ok {
		s.SDCard = &sd
	}
	if ams, ok := raw["ams"].(map[string]any); ok {
		if units, ok := ams["ams"].([]any); ok {
			for _, u := range units {
				um, ok := u.(map[string]any)
				if !ok {
					continue
				}
				id := int(numOr(um["id"], 0))
				unit := Unit{ID: id, Trays: []Tray{}}
				unit.Humidity = int(numOr(um["humidity"], 0))
				if h, ok := num(um["humidity_raw"]); ok {
					v := int(h)
					unit.HumidityPct = &v
				}
				if t, ok := num(um["temp"]); ok {
					unit.Temp = &t
				}
				ht := id >= 128
				if trays, ok := um["tray"].([]any); ok {
					for _, t := range trays {
						if tm, ok := t.(map[string]any); ok {
							unit.Trays = append(unit.Trays, tray(tm, id, int(numOr(tm["id"], 0)), ht))
						}
					}
				}
				for len(unit.Trays) < 4 && !ht {
					unit.Trays = append(unit.Trays, Tray{ID: id*4 + len(unit.Trays), Slot: len(unit.Trays), Remain: -1, Empty: true})
				}
				s.AMS.Units = append(s.AMS.Units, unit)
			}
		}
		if n, ok := num(ams["tray_now"]); ok && n >= 0 && n < 254 {
			v := int(n)
			s.AMS.Active = &v
		} else if ok && n == 254 {
			v := 254
			s.AMS.Active = &v
		}
	}
	if vt, ok := raw["vt_tray"].(map[string]any); ok {
		t := tray(vt, 0, 0, false)
		t.ID, t.Slot = 254, 0
		s.AMS.External = &t
	}
	for _, h := range anyList(raw["hms"]) {
		hm, ok := h.(map[string]any)
		if !ok {
			continue
		}
		s.HMS = append(s.HMS, hmsOf(uint32(numOr(hm["attr"], 0)), uint32(numOr(hm["code"], 0))))
	}
	if pe := uint32(numOr(raw["print_error"], 0)); pe != 0 {
		s.PrintError = fmt.Sprintf("%04X_%04X", pe>>16, pe&0xFFFF)
		s.PrintErrTxt = printErrorText(s.PrintError)
	}
	return s
}

func anyList(v any) []any {
	l, _ := v.([]any)
	return l
}

var modules = map[uint32]string{0x03: "motion controller", 0x05: "main board", 0x07: "AMS", 0x08: "toolhead", 0x0C: "camera", 0x12: "AMS"}

// plain words for the codes seen most often; the rest get a line that names the part
var known = map[string]string{
	"0300_400C": "The print was canceled.",
	"0500_4004": "The printer is busy and cannot start a new print.",
	"07FF_8012": "The printer could not get the AMS filament mapping. Check which spools are loaded and send again.",
}

func printErrorText(code string) string {
	if t, ok := known[code]; ok {
		return t
	}
	return "The printer stopped with error " + code + ". Check the printer's screen for what to do."
}

func hmsOf(attr, code uint32) HMS {
	sev := "info"
	switch code >> 16 {
	case 1:
		sev = "fatal"
	case 2:
		sev = "error"
	case 3:
		sev = "warn"
	}
	label := fmt.Sprintf("%04X_%04X_%04X_%04X", attr>>16, attr&0xFFFF, code>>16, code&0xFFFF)
	part := modules[attr>>24]
	text := "The printer reported a problem"
	if part != "" {
		text = "The " + part + " reported a problem"
	}
	short := fmt.Sprintf("%04X_%04X", attr>>16, code&0xFFFF)
	if t, ok := known[short]; ok {
		text = t
	} else {
		text += " (HMS " + strings.ReplaceAll(label, "_", "-") + "). Check the printer's screen for what to do."
	}
	return HMS{Code: strings.ReplaceAll(label, "_", "-"), Severity: sev, Text: text}
}

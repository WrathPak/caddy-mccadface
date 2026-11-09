package bambu

import (
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/json"
	"sort"
	"strings"
	"sync"
)

// The English HMS and print error texts and the Bambu wiki page of each code come from the ha-bambulab project (MIT,
// see hmsdata/NOTICE): custom_components/bambu_lab/pybambu/hms_error_text. They are kept gzipped and read on first use.

//go:embed hmsdata/hms_en.json.gz
var hmsGz []byte

//go:embed hmsdata/wiki_links.json.gz
var wikiGz []byte

// WikiHome is Bambu's public HMS page, the fallback link for a code with no page of its own.
const WikiHome = "https://wiki.bambulab.com/en/hms/home"

type texts struct {
	// code to text to the device types the text applies to (empty: all)
	Error map[string]map[string][]string `json:"device_error"`
	HMS   map[string]map[string][]string `json:"device_hms"`
}

var (
	loadOnce sync.Once
	words    texts
	wiki     map[string]map[string][]string
)

func gunzipJSON(b []byte, v any) {
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return
	}
	defer zr.Close()
	_ = json.NewDecoder(zr).Decode(v)
}

func load() {
	loadOnce.Do(func() {
		gunzipJSON(hmsGz, &words)
		gunzipJSON(wikiGz, &wiki)
	})
}

// devType is a model's name the way the tables spell it: "X1C", "A1MINI", "H2DPRO".
func devType(m Model) string {
	return strings.ToUpper(strings.NewReplacer(" ", "", "-", "").Replace(m.Name))
}

// pick chooses the text for a device type: one written for it, else the general one, else any (a text for another
// printer still says what part is meant).
func pick(opts map[string][]string, dev string) string {
	if len(opts) == 0 {
		return ""
	}
	keys := make([]string, 0, len(opts))
	for k := range opts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	general, any := "", ""
	for _, k := range keys {
		models := opts[k]
		if any == "" {
			any = k
		}
		if len(models) == 0 {
			if general == "" {
				general = k
			}
			continue
		}
		for _, m := range models {
			if m == dev {
				return k
			}
		}
	}
	if general != "" {
		return general
	}
	return any
}

// WikiURL is the Bambu wiki page for an HMS code (16 hex digits, no separators), or the HMS home page.
func WikiURL(code, dev string) string {
	load()
	if p := pick(wiki[code], dev); p != "" {
		return "https://wiki.bambulab.com" + p
	}
	return WikiHome
}

func hmsText(code, dev string) string {
	load()
	return pick(words.HMS[code], dev)
}

func errorText(code, dev string) string {
	load()
	return pick(words.Error[code], dev)
}

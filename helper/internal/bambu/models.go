// Package bambu talks to Bambu Lab printers on the LAN: MQTT for status and commands, FTPS for files, SSDP for discovery.
package bambu

import "strings"

// Model describes a printer family. Codes are what the printer announces over SSDP (DevModel) and what 3MF files carry.
type Model struct {
	Name  string // short name: "P1S"
	Label string // the machine preset prefix in Orca's profiles: "Bambu Lab P1S"
	// Storage: the printer starts jobs from its own storage and says so in its reports (H2D, H2S, P2S, ...)
	Storage bool
	// Dual: two nozzles, so the external spool has its own ids (H2D)
	Dual bool
	// PlainData: the FTP data channel may have to be plain, not TLS (A1 family firmware hangs on TLS there), tried after TLS fails
	PlainData bool
	// TLS12: the file server only works with TLS 1.2 or lower (P2S)
	TLS12 bool
	// NoVibration: no vibration calibration (P2S)
	NoVibration bool
}

var models = map[string]Model{
	"BL-P001": {Name: "X1C", Label: "Bambu Lab X1 Carbon"},
	"BL-P002": {Name: "X1", Label: "Bambu Lab X1"},
	"C13":     {Name: "X1E", Label: "Bambu Lab X1E"},
	"C11":     {Name: "P1P", Label: "Bambu Lab P1P"},
	"C12":     {Name: "P1S", Label: "Bambu Lab P1S"},
	"N7":      {Name: "P2S", Label: "Bambu Lab P2S", Storage: true, TLS12: true, NoVibration: true},
	"N6":      {Name: "X2D", Label: "Bambu Lab X2D", Storage: true, Dual: true},
	"N9":      {Name: "A2L", Label: "Bambu Lab A2L", Storage: true},
	"N1":      {Name: "A1 mini", Label: "Bambu Lab A1 mini", PlainData: true},
	"A12":     {Name: "A1 mini", Label: "Bambu Lab A1 mini", PlainData: true},
	"A04":     {Name: "A1 mini", Label: "Bambu Lab A1 mini", PlainData: true},
	"N2S":     {Name: "A1", Label: "Bambu Lab A1", PlainData: true},
	"A11":     {Name: "A1", Label: "Bambu Lab A1", PlainData: true},
	"O1D":     {Name: "H2D", Label: "Bambu Lab H2D", Storage: true, Dual: true},
	"O1E":     {Name: "H2D Pro", Label: "Bambu Lab H2D Pro", Storage: true, Dual: true},
	"O2D":     {Name: "H2D Pro", Label: "Bambu Lab H2D Pro", Storage: true, Dual: true},
	"O1S":     {Name: "H2S", Label: "Bambu Lab H2S", Storage: true},
	"O1C":     {Name: "H2C", Label: "Bambu Lab H2C", Storage: true, Dual: true},
	"O1C2":    {Name: "H2C", Label: "Bambu Lab H2C", Storage: true, Dual: true},
}

// serial number prefixes, for a printer whose model code is not known
var prefixes = map[string]string{
	"00M": "BL-P001", "00W": "BL-P002", "03W": "C13", "01S": "C11", "01P": "C12", "030": "N1", "039": "N2S",
	"093": "O1S", "094": "O1D", "239": "O1E", "31B": "O1C", "22E": "N7",
}

// ModelOf returns the model code and family for a code or short name, falling back to the serial's prefix.
func ModelOf(code, serial string) (string, Model) {
	code = strings.TrimSpace(code)
	if m, ok := models[code]; ok {
		return code, m
	}
	if code != "" {
		for k, m := range models {
			if strings.EqualFold(k, code) || strings.EqualFold(m.Name, code) || strings.EqualFold(m.Label, code) {
				return k, m
			}
		}
	}
	if len(serial) >= 3 {
		if c, ok := prefixes[strings.ToUpper(serial[:3])]; ok {
			return c, models[c]
		}
	}
	return code, Model{Name: "Bambu printer", Label: "Bambu Lab"}
}

package bambu

import (
	"strings"
	"testing"
)

func TestModelsAndUrlForms(t *testing.T) {
	cases := []struct{ in, name, url string }{
		{"N6", "X2D", "ftp:///a.3mf"}, {"BL-P001", "X1C", "ftp://a.3mf"}, {"x1c", "X1C", "ftp://a.3mf"}, {"C13", "X1E", "ftp://a.3mf"},
		{"C11", "P1P", "ftp://a.3mf"}, {"C12", "P1S", "ftp://a.3mf"}, {"N7", "P2S", "ftp:///a.3mf"}, {"N2S", "A1", "ftp://a.3mf"},
		{"A1MINI", "A1 mini", "ftp://a.3mf"}, {"O1D", "H2D", "ftp:///a.3mf"}, {"O1S", "H2S", "ftp:///a.3mf"}, {"H2C", "H2C", "ftp:///a.3mf"},
	}
	for _, c := range cases {
		_, m := ModelOf(c.in, "")
		if m.Name != c.name || m.jobURL("a.3mf") != c.url {
			t.Errorf("%s: got %s %s", c.in, m.Name, m.jobURL("a.3mf"))
		}
	}
}

func TestHmsWords(t *testing.T) {
	_, m := ModelOf("C12", "")
	if txt, _ := printErrorText("0300_400C", devType(m)); !strings.Contains(txt, "canceled") {
		t.Errorf("print error: %s", txt)
	}
	// a code that is in the table gets words and a wiki page; one that is not gets the generic line, its code and the wiki home
	known := hmsOf(0x03000100, 0x00010003, devType(m))
	if !known.Known || !strings.Contains(known.Text, "heatbed") || !strings.Contains(known.URL, "/troubleshooting/hmscode/0300_0100_0001_0003") {
		t.Errorf("known: %+v", known)
	}
	unknown := hmsOf(0x0300FFFF, 0x00FF00FF, devType(m))
	if unknown.Known || !strings.Contains(unknown.Text, "0300-FFFF-00FF-00FF") || unknown.URL != WikiHome {
		t.Errorf("unknown: %+v", unknown)
	}
}

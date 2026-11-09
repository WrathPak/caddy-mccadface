package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

// The proxy is how the app reaches a printer's own web API when the browser cannot (PrusaLink sends no CORS headers). It is not
// an open proxy: the request names a printer the person added, the address is always that printer's, the path is only a path,
// only a few harmless headers pass, and the helper adds the password or key itself (the browser never sees it).
var proxyMethods = map[string]bool{"GET": true, "HEAD": true, "PUT": true, "POST": true, "DELETE": true, "PATCH": true}

var proxyHeaders = map[string]bool{"Content-Type": true, "Accept": true, "Accept-Language": true, "Print-After-Upload": true, "Overwrite": true}

const maxProxyBody = 1 << 20

// cleanPath accepts a plain absolute path with an optional query, and nothing that could change the host.
func cleanPath(p string) bool {
	if !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") || strings.ContainsAny(p, "\\\r\n\t #") || strings.Contains(p, "://") {
		return false
	}
	u, err := url.ParseRequestURI(p)
	return err == nil && u.Scheme == "" && u.Host == "" && u.User == nil
}

func (c *conn) proxy(id string, data []byte) {
	var r httpReq
	if json.Unmarshal(data, &r) != nil {
		c.fail(id, ErrBadRequest, "That request is not valid.")
		return
	}
	d := c.s.mgr.Driver(r.PrinterID)
	if d == nil {
		c.fail(id, ErrNotFound, "No such printer, or it has no web interface.")
		return
	}
	method := strings.ToUpper(r.Method)
	if method == "" {
		method = "GET"
	}
	if !proxyMethods[method] || !cleanPath(r.Path) || len(r.Body) > maxProxyBody {
		c.fail(id, ErrBadRequest, "That request is not allowed.")
		return
	}
	hdr := map[string]string{}
	for k, v := range r.Headers {
		if ck := http.CanonicalHeaderKey(k); proxyHeaders[ck] && !strings.ContainsAny(v, "\r\n") {
			hdr[ck] = v
		}
	}
	var body []byte
	if r.Body != "" {
		body = []byte(r.Body)
	}
	ctx, cancel := context.WithTimeout(c.ctx, 20*time.Second)
	defer cancel()
	rep, err := d.Request(ctx, method, r.Path, hdr, body)
	if err != nil {
		c.failErr(id, err)
		return
	}
	out := map[string]any{"status": rep.Status, "headers": rep.Header}
	if utf8.Valid(rep.Body) {
		out["body"] = string(rep.Body)
	} else {
		out["bodyBase64"] = base64.StdEncoding.EncodeToString(rep.Body)
	}
	c.reply(id, out)
}

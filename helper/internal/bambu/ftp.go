package bambu

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/textproto"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jlaffaye/ftp"
)

// countReader reports how many bytes have been read, for the upload progress.
type countReader struct {
	r        io.Reader
	n        int64
	progress func(int64)
	last     time.Time
}

func (c *countReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	atomic.AddInt64(&c.n, int64(n))
	if c.progress != nil && (time.Since(c.last) > 150*time.Millisecond || err != nil) {
		c.last = time.Now()
		c.progress(atomic.LoadInt64(&c.n))
	}
	return n, err
}

// Upload puts a file in the printer's storage over implicit FTPS (port 990, user bblp, the access code as password).
// The data channel resumes the control channel's TLS session, which Bambu's server requires. The A1 family sometimes
// hangs on a TLS data channel, so after a failure it is tried once more with a plain one (what Bambuddy does).
// pin is the pinned file server certificate (empty: trust on first use); seen gets the fingerprint that was used.
// Canceling ctx closes the connections, which ends the transfer; the error then has the code "cancelled".
func Upload(ctx context.Context, t Target, m Model, name string, data []byte, progress func(sent int64), pin string, seen func(string)) error {
	err := upload(ctx, t, m, name, data, progress, pin, seen, true)
	var e *Error
	if err != nil && ctx.Err() == nil && m.PlainData && !(errors.As(err, &e) && (e.Code == CodeBadAccess || e.Code == CodeCertChanged || e.Code == CodeSDMissing)) {
		if err2 := upload(ctx, t, m, name, data, progress, pin, seen, false); err2 == nil {
			return nil
		}
	}
	if ctx.Err() != nil {
		return fail(CodeCancelled, "Cancelled.")
	}
	return err
}

// RemoveFile deletes a file from the printer's storage (the partial file of an upload that was cancelled). It tries a few
// times, because the printer may still be closing the transfer. A file that is not there is not an error.
func RemoveFile(t Target, name, pin string) error {
	cfg := tlsConfig(t.Serial, pin, nil)
	cfg.MaxVersion = tls.VersionTLS12
	dial := func(network, addr string) (net.Conn, error) {
		raw, err := (&net.Dialer{Timeout: 10 * time.Second}).Dial(network, addr)
		if err != nil {
			return nil, err
		}
		tc := tls.Client(raw, cfg)
		if err := tc.Handshake(); err != nil {
			raw.Close()
			return nil, err
		}
		return tc, nil
	}
	var last error
	for try := 0; try < 3; try++ {
		if try > 0 {
			time.Sleep(700 * time.Millisecond)
		}
		c, err := ftp.Dial(t.ftpAddr(), ftp.DialWithDialFunc(dial), ftp.DialWithTimeout(10*time.Second))
		if err != nil {
			last = err
			continue
		}
		if err = c.Login("bblp", t.AccessCode); err == nil {
			err = c.Delete(name)
			var te *textproto.Error
			if err == nil || (errors.As(err, &te) && te.Code == 550) {
				c.Quit()
				return nil
			}
		}
		last = err
		c.Quit()
	}
	return last
}

func upload(ctx context.Context, t Target, m Model, name string, data []byte, progress func(sent int64), pin string, seen func(string), dataTLS bool) error {
	cfg := tlsConfig(t.Serial, pin, seen)
	// TLS 1.2 resumes the session with no surprises (the P2S only speaks it); plain PASV like Python's ftplib, which the printers are tested with
	cfg.MaxVersion = tls.VersionTLS12
	var mu sync.Mutex
	var open []net.Conn
	track := func(c net.Conn) net.Conn {
		mu.Lock()
		open = append(open, c)
		mu.Unlock()
		return c
	}
	closeAll := func() {
		mu.Lock()
		for _, c := range open {
			c.Close()
		}
		mu.Unlock()
	}
	// our own dial function: the control channel is TLS from the first byte (implicit FTPS); a data channel is TLS on the
	// same config, so it resumes the control session (the handshake runs on the first write, after the 150 reply), or plain
	dial := func(network, addr string) (net.Conn, error) {
		d := net.Dialer{Timeout: 15 * time.Second}
		raw, err := d.Dial(network, addr)
		if err != nil {
			return nil, err
		}
		track(raw)
		if addr == t.ftpAddr() {
			tc := tls.Client(raw, cfg)
			if err := tc.Handshake(); err != nil {
				raw.Close()
				return nil, err
			}
			return tc, nil
		}
		if dataTLS {
			return tls.Client(raw, cfg), nil
		}
		return raw, nil
	}
	opts := []ftp.DialOption{ftp.DialWithDialFunc(dial), ftp.DialWithShutTimeout(2 * time.Minute), ftp.DialWithDisabledEPSV(true)}
	if dataTLS {
		opts = append(opts, ftp.DialWithTLS(cfg)) // makes the library send PBSZ 0 and PROT P
	}
	c, err := ftp.Dial(t.ftpAddr(), opts...)
	if err != nil {
		return ftpError(err)
	}
	defer c.Quit()
	defer closeAll()
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-ctx.Done():
			closeAll()
		case <-finished:
		}
	}()
	if err := c.Login("bblp", t.AccessCode); err != nil {
		return ftpError(err)
	}
	// a transfer that stops moving for 45 seconds is dropped
	cr := &countReader{r: bytes.NewReader(data), progress: progress}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		tk := time.NewTicker(5 * time.Second)
		defer tk.Stop()
		var prev int64 = -1
		stalled := 0
		for {
			select {
			case <-stop:
				return
			case <-tk.C:
				n := atomic.LoadInt64(&cr.n)
				if n == prev {
					if stalled++; stalled >= 9 {
						closeAll()
						return
					}
				} else {
					prev, stalled = n, 0
				}
			}
		}
	}()
	if err := c.Stor(name, cr); err != nil {
		// some printers (H2D) answer the transfer late or oddly: a file that arrived whole is a good upload
		if n, serr := c.FileSize(name); serr == nil && n == int64(len(data)) {
			return nil
		}
		return ftpError(err)
	}
	if progress != nil {
		progress(int64(len(data)))
	}
	return nil
}

func ftpError(err error) *Error {
	var te *textproto.Error
	if errors.As(err, &te) {
		switch {
		case te.Code == 530 || te.Code == 430:
			return fail(CodeBadAccess, "The printer refused the access code for file transfer. Check it on the printer's screen.")
		case te.Code == 552 || te.Code == 553 || te.Code == 550 || te.Code == 452 || te.Code == 451:
			return fail(CodeSDMissing, "The printer could not store the file. Check that a storage card is in the printer and has room (%s).", strings.TrimSpace(te.Msg))
		}
		return fail(CodeUpload, "The printer's file server said: %d %s", te.Code, strings.TrimSpace(te.Msg))
	}
	l := strings.ToLower(err.Error())
	if strings.Contains(l, "fingerprint changed") {
		return explain(err)
	}
	if strings.Contains(l, "refused") || strings.Contains(l, "timeout") || strings.Contains(l, "no route") || strings.Contains(l, "unreachable") {
		return fail(CodeUnreachable, "Could not reach the printer's file server (%s).", shorten(err.Error()))
	}
	return fail(CodeUpload, "The file transfer failed (%s).", shorten(err.Error()))
}

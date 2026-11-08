package server

import "encoding/json"

// The wire protocol, version 1. It mirrors src/features/print/link/protocol.ts: keep the two in step.

// ProtocolVersion is sent in hello.
const ProtocolVersion = 1

// error codes
const (
	ErrUnauthorized    = "unauthorized"
	ErrPairingRequired = "pairing_required"
	ErrBadCode         = "bad_code"
	ErrBadRequest      = "bad_request"
	ErrNotFound        = "not_found"
	ErrInternal        = "internal"
)

type envelope struct {
	ID   string `json:"id"`
	Type string `json:"type"`
}

type helloMsg struct {
	Type         string   `json:"type"`
	Version      int      `json:"version"`
	Helper       string   `json:"helper"`
	Capabilities []string `json:"capabilities"`
	Mock         bool     `json:"mock"`
}

type errorMsg struct {
	Type    string `json:"type"`
	ID      string `json:"id,omitempty"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// PrinterInfo is a printer as the app sees it: never the access code.
type PrinterInfo struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Model      string `json:"model"`
	ModelName  string `json:"modelName"`
	ModelLabel string `json:"modelLabel"`
	Serial     string `json:"serial"`
	IP         string `json:"ip"`
	Pinned     bool   `json:"pinned"`
	Storage    bool   `json:"storage"`
	Mock       bool   `json:"mock"`
}

type authReq struct {
	Token string `json:"token"`
}

type pairReq struct {
	Code string `json:"code"`
}

type addReq struct {
	Name       string `json:"name"`
	Serial     string `json:"serial"`
	IP         string `json:"ip"`
	AccessCode string `json:"accessCode"`
	Model      string `json:"model"`
	MQTTPort   int    `json:"mqttPort"`
	FTPPort    int    `json:"ftpPort"`
}

type printerReq struct {
	PrinterID string `json:"printerId"`
	On        bool   `json:"on"`
	Level     int    `json:"level"`
}

type sendBegin struct {
	PrinterID   string `json:"printerId"`
	FileName    string `json:"fileName"`
	Size        int64  `json:"size"`
	UseAMS      bool   `json:"useAms"`
	AMSMapping  []int  `json:"amsMapping"`
	BedLeveling bool   `json:"bedLeveling"`
	FlowCali    bool   `json:"flowCali"`
	Timelapse   bool   `json:"timelapse"`
}

type cancelReq struct {
	JobID string `json:"jobId"`
}

type sendEvent struct {
	Type      string `json:"type"`
	JobID     string `json:"jobId"`
	PrinterID string `json:"printerId"`
	Stage     string `json:"stage"`
	Sent      int64  `json:"sent"`
	Total     int64  `json:"total"`
	Code      string `json:"code,omitempty"`
	Message   string `json:"message,omitempty"`
}

func marshal(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

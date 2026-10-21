package main

import "testing"

// shipyardmm must be the same 29-byte v0 namespace the TypeScript client builds:
// version 0, eighteen zero id bytes, then the 10-byte id.
func TestShipyardNamespace(t *testing.T) {
	ns, err := userNamespace("shipyardmm")
	if err != nil {
		t.Fatal(err)
	}
	raw := ns.Bytes()
	if len(raw) != 29 {
		t.Fatalf("namespace length %d", len(raw))
	}
	for i := 0; i < 19; i++ {
		if raw[i] != 0 {
			t.Fatalf("byte %d is %d, want 0", i, raw[i])
		}
	}
	if got := string(raw[19:]); got != "shipyardmm" {
		t.Fatalf("namespace id %q", got)
	}
}

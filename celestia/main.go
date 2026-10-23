// mocha-helper posts and reads Celestia Mocha blobs with the official
// celestia-node Go client. The TypeScript scripts spawn this binary.
//
//	address  stdout: one celestia bech32 address
//	head     stdout: {"chainId","height"}
//	submit   stdin: raw blob bytes; stdout: {"height","commitment","address","balance"}
//	get      stdout: the raw blob bytes
//
// Errors go to stderr. A new mnemonic is written to a 0600 file under the
// keyring directory and is never printed. "insufficient funds" is the whole
// first stderr line when the account cannot pay for a blob.
package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/celestiaorg/celestia-app/v6/app"
	celencoding "github.com/celestiaorg/celestia-app/v6/app/encoding"
	"github.com/celestiaorg/celestia-node/api/client"
	"github.com/celestiaorg/celestia-node/blob"
	"github.com/celestiaorg/celestia-node/nodebuilder/p2p"
	"github.com/celestiaorg/celestia-node/state"
	"github.com/celestiaorg/go-square/v3/share"
	"github.com/cosmos/cosmos-sdk/crypto/hd"
	"github.com/cosmos/cosmos-sdk/crypto/keyring"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
)

const (
	defaultDA        = "https://public-endpoint.celestia-mocha.quiknode.pro"
	defaultCore      = "public-endpoint.celestia-mocha.quiknode.pro:9090"
	defaultNamespace = "shipyardmm"
	defaultNetwork   = "mocha-5"
	defaultKey       = "shipyard"
	defaultKeyring   = "celestia-keys"
	faucetURL        = "https://mocha.celenium.io/faucet"
	maxPayload       = 2 << 20
)

const usageText = `usage: mocha-helper <command> [flags]

  address  print the celestia address for a local test-keyring key
  head     read the DA chain head (read-only)
  submit   submit the raw blob on stdin, then read it back
  get      write the blob bytes for a height and commitment to stdout

Public Mocha defaults: DA ` + defaultDA + ` (TLS), core gRPC ` + defaultCore + ` (TLS), network ` + defaultNetwork + `.
Fund the printed address at ` + faucetURL + `.
Go 1.25.x is required to build this helper.`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, usageText)
		os.Exit(2)
	}
	var code int
	switch os.Args[1] {
	case "address":
		code = cmdAddress(os.Args[2:])
	case "head":
		code = cmdHead(os.Args[2:])
	case "submit":
		code = cmdSubmit(os.Args[2:])
	case "get":
		code = cmdGet(os.Args[2:])
	case "help", "-h", "--help":
		fmt.Fprintln(os.Stderr, usageText)
		code = 0
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n%s\n", os.Args[1], usageText)
		code = 2
	}
	os.Exit(code)
}

func cmdAddress(args []string) int {
	fs := flag.NewFlagSet("address", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	keyringDir := fs.String("keyring", defaultKeyring, "directory for the test keyring")
	keyName := fs.String("key", defaultKey, "key name")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	_, addr, _, err := openKeyring(*keyringDir, *keyName)
	if err != nil {
		return die(err)
	}
	fmt.Fprintf(os.Stderr, "Fund this address at %s\n", faucetURL)
	fmt.Fprintln(os.Stdout, addr)
	return 0
}

func cmdHead(args []string) int {
	fs := flag.NewFlagSet("head", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	da := fs.String("da", defaultDA, "DA JSON-RPC URL")
	daTLS := fs.Bool("da-tls", true, "dial the DA endpoint with TLS")
	network := fs.String("network", defaultNetwork, "expected chain id")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	rc, err := dialRead(ctx, *da, *daTLS)
	if err != nil {
		return die(err)
	}
	defer func() { _ = rc.Close() }()
	head, err := networkHead(ctx, rc, *network)
	if err != nil {
		return die(err)
	}
	return writeJSON(headOut{ChainID: head.ChainID(), Height: head.Height()})
}

func cmdGet(args []string) int {
	fs := flag.NewFlagSet("get", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	da := fs.String("da", defaultDA, "DA JSON-RPC URL")
	daTLS := fs.Bool("da-tls", true, "dial the DA endpoint with TLS")
	network := fs.String("network", defaultNetwork, "expected chain id")
	namespaceID := fs.String("namespace", defaultNamespace, "1 to 10 byte namespace id")
	height := fs.Uint64("height", 0, "block height")
	commitment := fs.String("commitment", "", "standard base64 blob commitment")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *height == 0 {
		return die(errors.New("height is required"))
	}
	ns, err := userNamespace(*namespaceID)
	if err != nil {
		return die(err)
	}
	com, err := decodeCommitment(*commitment)
	if err != nil {
		return die(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	rc, err := dialRead(ctx, *da, *daTLS)
	if err != nil {
		return die(err)
	}
	defer func() { _ = rc.Close() }()
	if _, err := networkHead(ctx, rc, *network); err != nil {
		return die(err)
	}
	retrieved, err := rc.Blob.Get(ctx, *height, ns, com)
	if err != nil {
		return die(fmt.Errorf("blob.Get height %d: %w", *height, err))
	}
	if _, err := os.Stdout.Write(retrieved.Data()); err != nil {
		return die(err)
	}
	return 0
}

func cmdSubmit(args []string) int {
	fs := flag.NewFlagSet("submit", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	keyringDir := fs.String("keyring", defaultKeyring, "directory for the test keyring")
	keyName := fs.String("key", defaultKey, "key name")
	da := fs.String("da", defaultDA, "DA JSON-RPC URL")
	daTLS := fs.Bool("da-tls", true, "dial the DA endpoint with TLS")
	core := fs.String("core", defaultCore, "consensus node gRPC host:port")
	coreTLS := fs.Bool("core-tls", true, "dial core gRPC with TLS")
	network := fs.String("network", defaultNetwork, "expected chain id")
	namespaceID := fs.String("namespace", defaultNamespace, "1 to 10 byte namespace id")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	payload, err := io.ReadAll(io.LimitReader(os.Stdin, maxPayload+1))
	if err != nil {
		return die(fmt.Errorf("read payload: %w", err))
	}
	if len(payload) == 0 {
		return die(errors.New("payload is empty"))
	}
	if len(payload) > maxPayload {
		return die(fmt.Errorf("payload is larger than %d bytes", maxPayload))
	}
	ns, err := userNamespace(*namespaceID)
	if err != nil {
		return die(err)
	}
	kr, addr, _, err := openKeyring(*keyringDir, *keyName)
	if err != nil {
		return die(err)
	}

	// The JSON-RPC client keeps this context for the life of the connection,
	// so phase timeouts are not cancelled out from under it. The budget covers
	// dial, the PayForBlobs submission, and the read-back.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cel, err := client.New(ctx, client.Config{
		ReadConfig: client.ReadConfig{
			BridgeDAAddr: *da,
			EnableDATLS:  *daTLS,
		},
		SubmitConfig: client.SubmitConfig{
			DefaultKeyName: *keyName,
			Network:        p2p.Network(*network),
			CoreGRPCConfig: client.CoreGRPCConfig{
				Addr:       *core,
				TLSEnabled: *coreTLS,
			},
		},
	}, kr)
	if err != nil {
		return die(fmt.Errorf("connect: %w", err))
	}
	defer func() { _ = cel.Close() }()

	if _, err := networkHead(ctx, &cel.ReadClient, *network); err != nil {
		return die(err)
	}
	balance, err := cel.State.Balance(ctx)
	if err != nil {
		if looksUnfunded(err) {
			return dieFunds(addr, "0utia", err.Error())
		}
		return die(fmt.Errorf("balance: %w", err))
	}
	zero, shown := balanceIsZero(balance)
	if zero {
		return dieFunds(addr, shown, "")
	}

	b, err := blob.NewBlob(share.ShareVersionZero, ns, payload, nil)
	if err != nil {
		return die(err)
	}
	height, err := cel.Blob.Submit(ctx, []*blob.Blob{b}, nil)
	if err != nil {
		if looksUnfunded(err) || zero {
			return dieFunds(addr, shown, err.Error())
		}
		return die(fmt.Errorf("blob.Submit: %w", err))
	}
	commitment := base64.StdEncoding.EncodeToString(b.Commitment)
	retrieved, err := cel.Blob.Get(ctx, height, ns, b.Commitment)
	if err != nil {
		return die(fmt.Errorf("blob submitted at height %d commitment %s, but reading it back failed: %w. posts.json was not updated; retrying post would submit again", height, commitment, err))
	}
	if !bytes.Equal(retrieved.Data(), payload) {
		return die(fmt.Errorf("blob submitted at height %d commitment %s, but the bytes read back do not match the payload. posts.json was not updated; retrying post would submit again", height, commitment))
	}
	return writeJSON(submitOut{
		Height:     height,
		Commitment: commitment,
		Address:    addr,
		Balance:    shown,
	})
}

func dialRead(ctx context.Context, da string, tls bool) (*client.ReadClient, error) {
	rc, err := client.NewReadClient(ctx, client.ReadConfig{
		BridgeDAAddr: da,
		EnableDATLS:  tls,
	})
	if err != nil {
		return nil, fmt.Errorf("connect DA: %w", err)
	}
	return rc, nil
}

func networkHead(ctx context.Context, rc *client.ReadClient, network string) (*headView, error) {
	head, err := rc.Header.NetworkHead(ctx)
	if err != nil {
		return nil, fmt.Errorf("DA network head: %w", err)
	}
	if head == nil {
		return nil, errors.New("DA network head was empty")
	}
	got := head.ChainID()
	if got != network {
		return nil, fmt.Errorf("DA chain id is %s, want %s", got, network)
	}
	return &headView{chainID: got, height: head.Height()}, nil
}

// headView is the subset of the extended header this helper prints.
type headView struct {
	chainID string
	height  uint64
}

func (h *headView) ChainID() string { return h.chainID }
func (h *headView) Height() uint64  { return h.height }

type headOut struct {
	ChainID string `json:"chainId"`
	Height  uint64 `json:"height"`
}

type submitOut struct {
	Height     uint64 `json:"height"`
	Commitment string `json:"commitment"`
	Address    string `json:"address"`
	Balance    string `json:"balance"`
}

func writeJSON(value any) int {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return die(err)
	}
	return 0
}

func userNamespace(id string) (share.Namespace, error) {
	var zero share.Namespace
	raw := []byte(id)
	if len(raw) < 1 || len(raw) > 10 {
		return zero, errors.New("namespace id must be 1 to 10 bytes")
	}
	ns, err := share.NewV0Namespace(raw)
	if err != nil {
		return zero, err
	}
	return ns, nil
}

func decodeCommitment(encoded string) (blob.Commitment, error) {
	if encoded == "" {
		return nil, errors.New("commitment is required")
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("commitment is not standard base64: %w", err)
	}
	if len(raw) == 0 {
		return nil, errors.New("commitment is empty")
	}
	return blob.Commitment(raw), nil
}

func balanceIsZero(b *state.Balance) (bool, string) {
	if b == nil {
		return true, "0utia"
	}
	shown := b.String()
	if shown == "" {
		shown = "0utia"
	}
	if b.Amount.IsNil() || b.Amount.IsZero() {
		return true, shown
	}
	return false, shown
}

func looksUnfunded(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "key not found") || strings.Contains(msg, "keyring") {
		return false
	}
	if strings.Contains(msg, "insufficient") {
		return true
	}
	if strings.Contains(msg, "does not exist") {
		return true
	}
	if strings.Contains(msg, "account") && strings.Contains(msg, "not found") {
		return true
	}
	return false
}

func dieFunds(addr, balance, cause string) int {
	if cause != "" {
		fmt.Fprintf(os.Stderr, "insufficient funds: %s balance %s. Fund this address at %s (%s)\n", addr, balance, faucetURL, cause)
	} else {
		fmt.Fprintf(os.Stderr, "insufficient funds: %s balance %s. Fund this address at %s\n", addr, balance, faucetURL)
	}
	return 1
}

func die(err error) int {
	fmt.Fprintf(os.Stderr, "mocha-helper: %s\n", err)
	return 1
}

// openKeyring opens the Cosmos test (unencrypted) keyring and creates the named
// key when it is missing. The mnemonic is written next to the keyring, mode
// 0600, and is not written to stdout. This is the same backend the celestia-node
// tutorial uses; do not point it at a directory you cannot keep private.
func openKeyring(dir, name string) (keyring.Keyring, string, bool, error) {
	if name == "" {
		return nil, "", false, errors.New("key name is empty")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, "", false, err
	}
	encConf := celencoding.MakeConfig(app.ModuleEncodingRegisters...)
	ring, err := keyring.New(app.Name, keyring.BackendTest, dir, os.Stdin, encConf.Codec)
	if err != nil {
		return nil, "", false, err
	}
	info, err := ring.Key(name)
	created := false
	if err != nil {
		if !errors.Is(err, sdkerrors.ErrKeyNotFound) {
			return nil, "", false, fmt.Errorf("read key %s: %w", name, err)
		}
		var mnemonic string
		info, mnemonic, err = ring.NewMnemonic(
			name,
			keyring.English,
			sdk.GetConfig().GetFullBIP44Path(),
			keyring.DefaultBIP39Passphrase,
			hd.Secp256k1,
		)
		if err != nil {
			return nil, "", false, fmt.Errorf("create key %s: %w", name, err)
		}
		created = true
		mnemonicPath := filepath.Join(dir, name+".mnemonic")
		if writeErr := os.WriteFile(mnemonicPath, []byte(mnemonic+"\n"), 0o600); writeErr != nil {
			return nil, "", false, fmt.Errorf("key %s was created but the mnemonic could not be saved to %s: %w", name, mnemonicPath, writeErr)
		}
		fmt.Fprintf(os.Stderr, "New Mocha key. Mnemonic saved to %s\n", mnemonicPath)
	}
	addr, err := info.GetAddress()
	if err != nil {
		return nil, "", false, err
	}
	bech := addr.String()
	if !strings.HasPrefix(bech, "celestia1") {
		return nil, "", false, fmt.Errorf("address %s is missing the celestia bech32 prefix", bech)
	}
	return ring, bech, created, nil
}

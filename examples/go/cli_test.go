package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestCLIRequiresToken(t *testing.T) {
	for _, transport := range []string{"http", "grpc"} {
		t.Run(transport, func(t *testing.T) {
			cmd := exec.Command(os.Args[0], "--transport", transport, "--port", "8787")
			cmd.Env = append(os.Environ(), "POLYGLOT_TEST_CLI=1", "POLYGLOT_TOKEN=")
			output, err := cmd.CombinedOutput()
			if err == nil {
				t.Fatal("network CLI accepted missing token")
			}
			if !strings.Contains(string(output), "startup or transport failure") {
				t.Fatalf("unexpected diagnostic: %s", output)
			}
		})
	}
}

func startCLI(t *testing.T, transport string) string {
	t.Helper()
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	_ = probe.Close()
	cmd := exec.Command(os.Args[0], "--transport", transport, "--port", strconv.Itoa(port))
	cmd.Env = append(os.Environ(), "POLYGLOT_TEST_CLI=1", "POLYGLOT_TOKEN=test-token")
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	ready := make(chan error, 1)
	go func() {
		reader := bufio.NewReader(stderr)
		line, err := reader.ReadString('\n')
		if err == nil && !strings.Contains(line, "listening on 127.0.0.1:") {
			err = fmt.Errorf("unexpected CLI output: %s", line)
		}
		ready <- err
		_, _ = io.Copy(io.Discard, reader)
	}()
	select {
	case err := <-ready:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("CLI did not start")
	}
	return fmt.Sprintf("127.0.0.1:%d", port)
}

func TestNetworkCLI(t *testing.T) {
	for _, transport := range []string{"http", "grpc"} {
		t.Run(transport, func(t *testing.T) {
			target := startCLI(t, transport)
			for i := 0; i < 2; i++ {
				if transport == "http" {
					w, _ := httpClient(t, "http://"+target, "test-token")
					exercise(t, w)
				} else {
					exercise(t, grpcClient(t, target, "test-token"))
				}
			}
		})
	}
}

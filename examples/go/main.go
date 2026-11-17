package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	if err := run(); err != nil {
		// Deliberately do not print request data, tokens, or transport error text.
		fmt.Fprintln(os.Stderr, "polyglot: startup or transport failure (check flags, token, and port)")
		os.Exit(1)
	}
}
func run() error {
	transport := flag.String("transport", "stdio", "stdio, http, or grpc")
	port := flag.Int("port", 8787, "loopback listen port (HTTP or gRPC)")
	flag.Parse()
	if flag.NArg() != 0 || *port < 1 || *port > 65535 {
		return fmt.Errorf("invalid arguments")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *transport == "stdio" {
		return serveStdio(ctx, os.Stdin, os.Stdout)
	}
	if *transport != "http" && *transport != "grpc" {
		return fmt.Errorf("invalid transport")
	}
	token := os.Getenv("POLYGLOT_TOKEN")
	if strings.TrimSpace(token) == "" || strings.ContainsAny(token, "\r\n") {
		return fmt.Errorf("missing or invalid token")
	}
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		return err
	}
	defer listener.Close()
	fmt.Fprintf(os.Stderr, "polyglot: %s listening on 127.0.0.1:%d\n", *transport, *port)
	if *transport == "http" {
		handler := newHTTPTransport(token)
		defer handler.close()
		server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 * 1024}
		go func() {
			<-ctx.Done()
			handler.close()
			shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if server.Shutdown(shutdown) != nil {
				_ = server.Close()
			}
		}()
		err := server.Serve(listener)
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	}
	server := newGRPCServer(token)
	go func() {
		<-ctx.Done()
		// A process signal is different from a protocol shutdown. Stop all
		// streams on a signal so blocked clients cannot delay process exit.
		server.Stop()
	}()
	err = server.Serve(listener)
	if ctx.Err() != nil {
		return nil
	}
	return err
}

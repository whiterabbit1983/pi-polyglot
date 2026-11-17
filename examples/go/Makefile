# All downloaded modules, build caches, tools, and binaries stay in this example.
export GOPATH := $(CURDIR)/.cache/gopath
export GOMODCACHE := $(CURDIR)/.cache/mod
export GOCACHE := $(CURDIR)/.cache/build
export GOTOOLCHAIN := local

.PHONY: deps build test check linux fmt

deps:
	go mod download

build:
	go build -mod=readonly -o bin/polyglot-example .

test:
	go test -mod=readonly -race -count=1 -timeout=120s ./...

check:
	go vet -mod=readonly ./...
	go mod verify

linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -mod=readonly -o bin/polyglot-example-linux-amd64 .

fmt:
	gofmt -w *.go

package main

import (
	"bufio"
	"bytes"
	"context"
	"io"
)

func serveStdio(ctx context.Context, input io.ReadCloser, output io.WriteCloser) error {
	s := newSession()
	defer s.close()
	defer input.Close()
	defer output.Close()
	go func() {
		select {
		case <-ctx.Done():
		case <-s.ctx.Done():
		}
		// Closing pipe descriptors also unblocks a stalled writer on loss or
		// cancellation. stdout is owned by this stdio connection.
		_ = input.Close()
		_ = output.Close()
	}()
	go func() {
		reader := bufio.NewReaderSize(input, 32*1024)
		frame := make([]byte, 0, 32*1024)
		for {
			part, err := reader.ReadSlice('\n')
			if len(frame)+len(part) > maxFrame+1 {
				s.close()
				return
			}
			frame = append(frame, part...)
			if err == bufio.ErrBufferFull {
				continue
			}
			if err != nil {
				s.close()
				return
			} // EOF, including an unterminated frame, loses the connection.
			frame = bytes.TrimSuffix(frame, []byte{'\n'})
			if s.accept(frame) != nil {
				return
			}
			frame = frame[:0]
		}
	}()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-s.ctx.Done():
			return nil
		case frame := <-s.out:
			data := append(frame.data, '\n')
			if _, err := output.Write(data); err != nil {
				return err
			}
			if frame.closeAfter {
				return nil
			}
		}
	}
}

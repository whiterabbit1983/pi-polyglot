package main

import (
	"crypto/sha256"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protodesc"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/descriptorpb"
	"google.golang.org/protobuf/types/dynamicpb"
)

// This descriptor mirrors ../../proto/extension.proto exactly. dynamicpb uses
// the standard protobuf wire codec; protoc and a private/custom codec are not
// required. In particular, Frame.json is a protobuf STRING, field number 1.
var frameDescriptor = func() protoreflect.MessageDescriptor {
	file, err := protodesc.NewFile(&descriptorpb.FileDescriptorProto{
		Name: proto.String("extension.proto"), Package: proto.String("pi.polyglot.v1"), Syntax: proto.String("proto3"),
		MessageType: []*descriptorpb.DescriptorProto{{Name: proto.String("Frame"), Field: []*descriptorpb.FieldDescriptorProto{{
			Name: proto.String("json"), Number: proto.Int32(1), Label: descriptorpb.FieldDescriptorProto_LABEL_OPTIONAL.Enum(), Type: descriptorpb.FieldDescriptorProto_TYPE_STRING.Enum(),
		}}}},
		Service: []*descriptorpb.ServiceDescriptorProto{{Name: proto.String("Extension"), Method: []*descriptorpb.MethodDescriptorProto{{
			Name: proto.String("Connect"), InputType: proto.String(".pi.polyglot.v1.Frame"), OutputType: proto.String(".pi.polyglot.v1.Frame"), ClientStreaming: proto.Bool(true), ServerStreaming: proto.Bool(true),
		}}}},
	}, nil)
	if err != nil {
		panic("invalid built-in protobuf descriptor")
	}
	return file.Messages().ByName("Frame")
}()
var jsonField = frameDescriptor.Fields().ByNumber(1)

func newFrame(data []byte) *dynamicpb.Message {
	frame := dynamicpb.NewMessage(frameDescriptor)
	frame.Set(jsonField, protoreflect.ValueOfString(string(data)))
	return frame
}

type extensionServer interface{ Connect(grpc.ServerStream) error }
type grpcTransport struct {
	tokenHash [32]byte
	slots     chan struct{}
}

func newGRPCServer(token string) *grpc.Server {
	t := &grpcTransport{sha256.Sum256([]byte("Bearer " + token)), make(chan struct{}, maxSessions)}
	server := grpc.NewServer(grpc.MaxRecvMsgSize(maxFrame+16), grpc.MaxSendMsgSize(maxFrame+16), grpc.MaxConcurrentStreams(maxSessions))
	server.RegisterService(&grpc.ServiceDesc{
		ServiceName: "pi.polyglot.v1.Extension", HandlerType: (*extensionServer)(nil),
		Streams:  []grpc.StreamDesc{{StreamName: "Connect", ClientStreams: true, ServerStreams: true, Handler: func(srv any, stream grpc.ServerStream) error { return srv.(extensionServer).Connect(stream) }}},
		Metadata: "extension.proto",
	}, t)
	return server
}
func (t *grpcTransport) Connect(stream grpc.ServerStream) error {
	md, _ := metadata.FromIncomingContext(stream.Context())
	if !authorized(t.tokenHash, md.Get("authorization")) {
		return status.Error(codes.Unauthenticated, "Unauthorized")
	}
	select {
	case t.slots <- struct{}{}:
		defer func() { <-t.slots }()
	default:
		return status.Error(codes.ResourceExhausted, "Stream limit")
	}
	s := newSession()
	defer s.close()
	readDone := make(chan error, 1)
	writeDone := make(chan error, 1)
	go func() {
		for {
			frame := dynamicpb.NewMessage(frameDescriptor)
			if err := stream.RecvMsg(frame); err != nil {
				readDone <- err
				return
			}
			if err := s.accept([]byte(frame.Get(jsonField).String())); err != nil {
				readDone <- status.Error(codes.InvalidArgument, "Invalid frame")
				return
			}
		}
	}()
	go func() {
		for {
			select {
			case <-s.ctx.Done():
				return
			case frame := <-s.out:
				if err := stream.SendMsg(newFrame(frame.data)); err != nil {
					writeDone <- err
					return
				}
				if frame.closeAfter {
					writeDone <- nil
					return
				}
			}
		}
	}()
	// Returning the handler cancels blocked RecvMsg/SendMsg calls. Never call
	// server.Stop for a protocol shutdown: only this stream must end.
	select {
	case <-stream.Context().Done():
		return stream.Context().Err()
	case <-s.ctx.Done():
		return status.Error(codes.Canceled, "Connection closed")
	case err := <-readDone:
		return err
	case err := <-writeDone:
		return err
	}
}

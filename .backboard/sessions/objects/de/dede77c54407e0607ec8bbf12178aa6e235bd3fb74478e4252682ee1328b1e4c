# Process and control contracts

The web server owns GPIO, pump, motion, tracking, viewers, WebRTC peers, and worker supervision. The inference worker owns the camera, RKNN context, preprocessing, JPEG encoding, and the AprilTag child. The AprilTag child has one grayscale frame in flight and emits JSON lines. The worker never waits for tag completion. These processes must have separate entrypoints.

## Packet contract

Unix socket records are `[u8 type][u32le payloadLength][payload]`. A parser must reject oversized records before allocation and tolerate partial headers/payloads. Frame records include monotonically increasing `seq`, capture `timestampMs`, dimensions and JPEG bytes. Detection records include the same `seq` and timestamp. Control records contain length-prefixed JSON. Explicit ACK records name the sequence. Each sender keeps at most two frames in flight; overflow evicts the oldest pending frame. A frame not ACKed within 30 seconds is a stalled-reader fault. The server probes a socket before unlinking it and reconnects to external workers without taking ownership of their socket.

## Safety state

The server starts with drivers disabled and pump off. An e-stop latches, cancels motion, drives both EN outputs high, drives pump off, and kills helper process groups. Releasing e-stop requires an explicit operator action and does not automatically re-enable motors. Shutdown and last-viewer loss stop pump/motion and disable tracking. Every continuous movement has a step cap. Pump holds have an independent on-time cap; no detection or tracking path can invoke pump on.

Each yaw limit is an independent input associated with a configurable physical end. An already pressed switch permits only configured move-away grace. A newly hit switch triggers bounded backoff for that end. Tracking yaw output is zero while either switch is pressed. Pitch has no assumed switches.

## Configuration and measurements

Required target measurements before enabling hardware: relay active polarity, yaw switch-to-end mapping, gpiod ABI against installed `gpiod.h`, GPIO chip mapping/permission, camera capture node and format, RKNN model tensor metadata, and NPU core behavior. These remain configuration values until observed on the Pi. A test using mocks is evidence for control logic only.

# Diagram 1 — System Architecture

High-level view of components and how they connect. The API server and the
three workers are separate processes; queues (Redis/BullMQ) decouple them, and
MongoDB + MinIO are the shared state and object stores.

```mermaid
flowchart TB
    Client([Client])

    subgraph API["API Server (Express)"]
        Routes["/api/videos routes"]
        Controller["video.controller"]
    end

    subgraph Queues["Redis + BullMQ"]
        IQ[("inspection queue")]
        PQ[("planner queue")]
        TQ[("transcoder queue")]
    end

    subgraph Workers["Worker Processes (independent)"]
        IW["inspection.worker<br/>(ffprobe)"]
        PW["planner.worker<br/>(rendition ladder)"]
        TW["transcoder.worker<br/>(ffmpeg → HLS)"]
    end

    Mongo[("MongoDB<br/>Video documents")]
    MinIO[("MinIO<br/>object storage")]

    Client -->|1. initiate-upload| Routes
    Routes --> Controller
    Controller -->|presigned PUT url| Client
    Client -->|2. PUT original.mp4| MinIO
    Client -->|3. complete-upload| Routes
    Controller -->|enqueue| IQ

    IQ --> IW
    IW -->|enqueue| PQ
    PQ --> PW
    PW -->|enqueue| TQ
    TQ --> TW

    Controller -.read/write.-> Mongo
    IW -.read/write.-> Mongo
    PW -.read/write.-> Mongo
    TW -.read/write.-> Mongo

    IW -.download.-> MinIO
    TW -.download original.-> MinIO
    TW -.upload HLS.-> MinIO
```

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"sync/atomic"
	"testing"
	"time"
)

// A barrier proves real parallel execution; each next batch must still respect
// the worker bound. The ordinary buffer also exercises race-free progress writes.
func TestProcessAssetsParallelAndBounded(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	assets := make([]archiveAsset, 32)
	for i := range assets {
		assets[i].Path = fmt.Sprint(i)
	}
	var active, peak, calls atomic.Int32
	started := make(chan struct{}, len(assets))
	release := make(chan struct{})
	done := make(chan error, 1)
	var progress bytes.Buffer
	go func() {
		done <- processAssets(ctx, assets, &progress, "test", func(ctx context.Context, _ archiveAsset) error {
			n := active.Add(1)
			defer active.Add(-1)
			for old := peak.Load(); n > old; old = peak.Load() {
				if peak.CompareAndSwap(old, n) {
					break
				}
			}
			calls.Add(1)
			started <- struct{}{}
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
	}()
	for i := 0; i < assetWorkers; i++ {
		select {
		case <-started:
		case <-ctx.Done():
			t.Fatal("workers did not run concurrently")
		}
	}
	if peak.Load() != assetWorkers {
		t.Fatalf("peak concurrency %d", peak.Load())
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if calls.Load() != int32(len(assets)) || active.Load() != 0 || peak.Load() > assetWorkers {
		t.Fatal("missing work or unbounded workers")
	}
	if !bytes.Contains(progress.Bytes(), []byte("32/32 assets complete")) {
		t.Fatal(progress.String())
	}
}

// An error must cancel blocked peers and drain them before the caller returns.
func TestProcessAssetsFailureCancelsPeers(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	failure := errors.New("upload failed")
	assets := make([]archiveAsset, assetWorkers)
	for i := range assets {
		assets[i].Path = fmt.Sprint(i)
	}
	var active atomic.Int32
	barrier := make(chan struct{})
	var arrived atomic.Int32
	err := processAssets(ctx, assets, io.Discard, "test", func(ctx context.Context, asset archiveAsset) error {
		active.Add(1)
		defer active.Add(-1)
		if arrived.Add(1) == assetWorkers {
			close(barrier)
		}
		select {
		case <-barrier:
		case <-ctx.Done():
			return ctx.Err()
		}
		if asset.Path == "0" {
			return failure
		}
		<-ctx.Done()
		return ctx.Err()
	})
	if !errors.Is(err, failure) {
		t.Fatalf("got %v", err)
	}
	if active.Load() != 0 {
		t.Fatal("returned while workers were active")
	}
}

func TestProcessAssetsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := processAssets(ctx, []archiveAsset{{Path: "unused"}}, io.Discard, "test", func(context.Context, archiveAsset) error { t.Error("started after cancellation"); return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
}

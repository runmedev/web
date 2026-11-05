package main

import (
	"context"
	"fmt"
	"io"
	"sync"
	"time"
)

const assetWorkers = 8

// processAssets bounds subprocess and network concurrency. Only the coordinator
// writes progress, so callers may use ordinary writers. A failure cancels sibling
// work and all workers finish before callers can publish a completion manifest.
func processAssets(ctx context.Context, assets []archiveAsset, out io.Writer, phase string, operation func(context.Context, archiveAsset) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	started := time.Now()
	fmt.Fprintf(out, "%s: starting %d assets with up to %d workers\n", phase, len(assets), assetWorkers)
	jobs := make(chan archiveAsset)
	results := make(chan error, assetWorkers)
	var workers sync.WaitGroup
	for i := 0; i < min(assetWorkers, len(assets)); i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for asset := range jobs {
				if ctx.Err() != nil {
					return
				}
				err := operation(ctx, asset)
				if err != nil {
					err = fmt.Errorf("%s %s: %w", phase, asset.Path, err)
				}
				results <- err
			}
		}()
	}
	go func() {
		defer close(jobs)
		for _, asset := range assets {
			select {
			case jobs <- asset:
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() { workers.Wait(); close(results) }()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	completed := 0
	var firstError error
	report := func() {
		fmt.Fprintf(out, "%s: %d/%d assets complete (%s elapsed)\n", phase, completed, len(assets), time.Since(started).Round(time.Second))
	}
	for {
		select {
		case err, open := <-results:
			if !open {
				report()
				if firstError != nil {
					return firstError
				}
				return ctx.Err()
			}
			if err != nil && firstError == nil {
				firstError = err
				cancel()
			}
			if err == nil {
				completed++
			}
		case <-ticker.C:
			report()
		}
	}
}

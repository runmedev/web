package main

import "testing"

func TestIsMissingVersionMarkerError(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		err  error
		want bool
	}{
		{
			name: "gcloud matched no objects",
			err:  errString("exit status 1: ERROR: (gcloud.storage.cat) The following URLs matched no objects or files:\ngs://runme-hosted/version.yaml"),
			want: true,
		},
		{
			name: "gcloud no urls matched",
			err:  errString("exit status 1: ERROR: (gcloud.storage.cat) No URLs matched: gs://runme-hosted/version.yaml"),
			want: true,
		},
		{
			name: "http 404",
			err:  errString("404 Not Found"),
			want: true,
		},
		{
			name: "other gcloud error",
			err:  errString("exit status 1: permission denied"),
			want: false,
		},
		{
			name: "nil",
			err:  nil,
			want: false,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := isMissingVersionMarkerError(tc.err)
			if got != tc.want {
				t.Fatalf("isMissingVersionMarkerError() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestVersionBuildEnv(t *testing.T) {
	t.Parallel()

	version := releaseVersion{
		BuildDate: "2026-06-03T12:00:00Z",
		WebRepo:   "runmedev/web",
		WebBranch: "main",
		WebCommit: "web-sha",
		Bucket:    "gs://runme-hosted",
	}

	got := versionBuildEnv(version)
	want := []string{
		"VITE_RUNME_VERSION_BUILD_DATE=2026-06-03T12:00:00Z",
		"VITE_RUNME_VERSION_WEB_REPO=runmedev/web",
		"VITE_RUNME_VERSION_WEB_BRANCH=main",
		"VITE_RUNME_VERSION_WEB_COMMIT=web-sha",
		"VITE_RUNME_VERSION_BUCKET=gs://runme-hosted",
	}
	if len(got) != len(want) {
		t.Fatalf("versionBuildEnv() returned %d entries, want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("versionBuildEnv()[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

type errString string

func (e errString) Error() string {
	return string(e)
}

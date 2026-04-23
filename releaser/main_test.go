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

type errString string

func (e errString) Error() string {
	return string(e)
}

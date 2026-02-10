# Notebook App

This is a notebook UI for Runme providing a Google CoLab like UX with docs stored in Google Drive

## Build The UI Locally

Build it with bazel

```sh
# From the root of the repo
cd ../
pnpm run dev:app
```

# Configuring the Application

## Get a Google OAuth Client

In order to be able to access Google Drive.

Follow the [Google docs](https://support.google.com/cloud/answer/15549257?sjid=2630967979572079554-NC) for creating
an OAuth credential with the following settings

* Application Type: Web Application
* Authorized redirect URIs:
   - http://localhost:5173
   - http://localhost:5174

If you plan on hosting the app at your own domain you'll need to add the redirect URI at which your app gets served

Save the clientID and client secret you'll need them in the next step.

## Configure the web app

Open the web app at [http://localhost:5173](http://localhost:5173).

Expand the App Console at the bottom of the screen and run the following commands to configure your oauth client.

```ini
credentials.google.setClientSecret("<YOUR CLIENT SECRET>")
credentials.google.setClientId("<YOUR CLIENT ID>")
```

Refresh the webapp for the settings to take effect.

## Configure Signon in the webapp with OIDC

You need to signon into the app in order to authenticate to the different services the app talks to (e.g. kernels and the AI backend).
You do this with OIDC. You'll need an OIDC provider such as

* Google
* Microsoft Entra
* GitHub

### Using Google

[Google OIDC docs](https://developers.google.com/identity/openid-connect/openid-connect)

You can reuse the OAuthClient you created for Google Drive but you'll need to update your
OAuth client as follows

Add the redirect URI

```sh
http://localhost:5173/oidc/callback
```

Add additional URIs as needed

- If you are running the development server on different ports add those URLs as well
- If you are deploying the app at some server or using https update the URIs accordingly

In the app console run the following to set the discovery URL and scopes

```sh
oidc.setGoogleDefaults()
```

Then run the following to set your clientID and clientSecret to the same ones you set above for Google Drive.

```sh
oidc.setClientToDrive()
```

You should now be able to sign.

After you sign in you can verify the status and ID information in the App Console by running.

```sh
oidc.getStatus()
```

This should print out information about your OIDC token.

## Run a server

We need to start the Runme server to provide a kernel and AI backend.

Clone the Runme Repo [https://github.com/runmedev/runme](https://github.com/runmedev/runme)

**N.B** Right now you need to use the branch "dev/jlewi/webapp"

Setup your configuration

```sh
cp ${REPODIR}$/app/config.dev.yaml \
  ${HOME}/.runme-agent/config.dev.yaml
```

Make the relevant changes to your config

* Set the path to your OpenAI API Key
* Change your email in the IAM rules
* Add the Google OAuth Client ID

```sh
go run ./ agent --config=${HOME}/.runme-agent/config.dev.yaml serve
```

# Configure the server to serve app configuration

* You can configure the app with one command by hosting the application configuration at a URL
* For example you can put a YAML files into the assets directory (e.g. `${HOME}/.runme-agent/assets/configs/app-configs.yaml`) to
  host the OIDC and Google Drive configuration that the App should use. For example.

  ```yaml
  # app-configs.yaml is a file that will be served by the server as a static asset.
    # It will be used by the frontend to configure itself.
    # The agent mints OAuth tokens for the user to login to the assistant and the runners
    oidc:
        # OIDC callback handling should happen in the browser.
        clientExchange: true    
        google:
            # Need to set the clientID to validate the audience tokens
            clientID: "44661292282-bdt3on71kvc489nvi3l37gialolcnk0a.apps.googleusercontent.com"

    googleDrive:
        clientID: "44661292282-bqhl39ugf2kn7r8vv4f6766jt0a7tom9.apps.googleusercontent.com"
        clientSecret: ""
  ```


* Then in the web in the console you can do.

  ```
  app.setConfig(app.getDefaultConfigUrl())
  ```

## Configure the Runner

In the web app we need to configure a runner on which to execute cells

In the app console.

```sh
aisre.runners.update("localhost","ws://localhost:9977/ws")
```

* Change the port to whatever port your runme agent is serving on

## Deployment

The web app can be published as a static-assets OCI artifact (not a runnable container image).

### Publish static assets to GHCR

This repo includes a GitHub Actions workflow at `.github/workflows/publish-app-assets-oci.yaml` that:

1. Builds the app with `pnpm -C app run build`
2. Packages `app/dist` into `app-assets.tgz` with files under `assets/`
3. Pushes the tarball to GHCR as an OCI artifact using `oras`

The artifact is published as:

* `ghcr.io/runmedev/app-assets:sha-<commit-sha>`
* `ghcr.io/runmedev/app-assets:latest` (for `main`)

It uses a custom artifact type:

* `application/vnd.runmeweb.assets.v1`

### Pull and extract the static assets

Install [ORAS](https://oras.land/) and then pull/extract:

```sh
oras pull ghcr.io/runmedev/app-assets:latest
mkdir -p site
tar -xzf app-assets.tgz -C site
```

After extraction, the app files are in `site/assets/` and can be served by any static file server or uploaded to object storage/CDN.

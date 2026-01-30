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

```
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

```
http://localhost:5173/oidc/callback
```

Add additional URIs as needed
- If you are running the development server on different ports add those URLs as well
- If you are deploying the app at some server or using https update the URIs accordingly


In the app console run the following to set the discovery URL and scopes

```
oidc.setGoogleDefaults()
```

Then run the following to set your clientID and clientSecret to the same ones you set above for Google Drive.

```
oidc.setClientToDrive()
```

You should now be able to sign

## Run a server

TODO(jlewi): need to update this

## Deployment

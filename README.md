# Component Analysis LSP Server

LSP Server that can analyze your dependencies specified in `package.json`.

## Build

```
npm install
npm run-script build
```

## Setup
we use 2 environment variables to setup the recommender API
```
export RECOMMENDER_API_URL=https://recommender.api.openshift.io/api/v1
export RECOMMENDER_API_TOKEN=the-token

```

##Run in Visual Studio Code
```
cd vscode-hack
npm install
code .
```

Hit F5 to run the project in debug mode.

## License

Apache-2.0

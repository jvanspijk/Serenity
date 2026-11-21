# Serenity

Serenity is a small web chat UI for OpenAI-compatible model servers. It uses Node.js with plain HTML, CSS, and JavaScript. Docker includes Python and DDGS for web search.

## Run with Docker

You need Docker with Compose and a running OpenAI-compatible model server, such as Ollama, llama.cpp, or LM Studio.

```sh
docker compose up --build -d
```

Open <http://127.0.0.1:8080>, configure the inference URL in **Settings**, and refresh the model list. The default URL is `http://host.docker.internal:11434/v1` (Ollama on the Docker host). The model server must be reachable from the container.

Optionally, create a `.env` file next to `compose.yaml` to set initial values:

```dotenv
WEB_PORT=8080
INFERENCE_URL=http://host.docker.internal:11434/v1
# INFERENCE_API_KEY=your-api-key
# BIND_ADDRESS=127.0.0.1
```

Saved settings take precedence over initial inference settings. Stop the app with `docker compose down`; its named volume retains chats and settings.

## Run from source

Install Node.js 24 or newer, then run:

```sh
npm ci
npm start
```

Open <http://127.0.0.1:8080>. The default inference URL is `http://127.0.0.1:11434/v1`. You can set `HOST`, `PORT`, `DATA_DIR`, `INFERENCE_URL`, and `INFERENCE_API_KEY` as environment variables before starting the server.

For web search, install Python 3.10 or newer and run `python -m pip install -r requirements.txt`. Serenity uses `python` on Windows and `python3` elsewhere. Set `SERENITY_PYTHON` to the Python executable if needed, for example when using a virtual environment.

Run the tests with:

```sh
node --test
```

## Data and plugins

Chats and settings are stored in the Docker volume, or in `./data` when running from source. Settings can include API keys and MCP tokens; protect the data and its backups. Serenity has no authentication, so keep it on localhost or behind an authenticated reverse proxy.

Place trusted plugin folders in `plugins/` and restart the app. See the [plugin guide](docs/plugins.md) and [example plugin](examples/word-count/). Web tools and MCP connections are configured in the app and require a model that supports tool calls.

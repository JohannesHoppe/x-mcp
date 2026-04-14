# x-autonomous-mcp Helm Chart

Deploys x-autonomous-mcp as an HTTP MCP server (via supergateway) on Kubernetes.

## Usage

```bash
helm install x-mcp ./charts \
  --set secret.X_API_KEY=your-key \
  --set secret.X_API_SECRET=your-secret \
  --set secret.X_ACCESS_TOKEN=your-token \
  --set secret.X_ACCESS_TOKEN_SECRET=your-token-secret \
  --set secret.X_BEARER_TOKEN=your-bearer-token
```

## From the agent

The MCP server is reachable at:

```
http://<release-name>-x-mcp:8000/sse        # SSE subscribe
http://<release-name>-x-mcp:8000/message     # POST messages
http://<release-name>-x-mcp:8000/healthz     # Health check
```

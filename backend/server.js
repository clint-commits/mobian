console.log('Server starting...')
import express from 'express'
import cors from 'cors'
import Anthropic from '@anthropic-ai/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const app = express()
app.use(cors({ origin: process.env.CORS_ORIGIN ?? '*' }))
app.use(express.json())

let anthropic
try {
  anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
} catch (err) {
  console.error('Failed to initialize Anthropic:', err)
  process.exit(1)
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
  process.exit(1)
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason)
  process.exit(1)
})

async function getMobianClient() {
  const client = new Client({ name: 'testapp', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(
    new URL(process.env.MOBIAN_MCP_URL),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${process.env.MOBIAN_API_KEY}` },
      },
    }
  )
  await client.connect(transport)
  return client
}

app.get('/', (req, res) => res.json({ status: 'ok' }))

app.post('/api/claude', async (req, res) => {
  const { prompt } = req.body
  if (!prompt) return res.status(400).json({ error: 'prompt is required' })

  let mcp
  try {
    // Connect to Mobian and fetch tools
    mcp = await getMobianClient()
    const { tools: mcpTools } = await mcp.listTools()

    // Convert MCP tool format → Anthropic tool format
    const tools = mcpTools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema ?? { type: 'object', properties: {} },
    }))

    const messages = [{ role: 'user', content: prompt }]

    // Agentic loop — keep going until Claude stops calling tools
    let response
    while (true) {
      response = await anthropic.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 1024,
        tools,
        messages,
      })

      if (response.stop_reason !== 'tool_use') break

      // Execute each tool call via Mobian
      messages.push({ role: 'assistant', content: response.content })

      const toolResults = await Promise.all(
        response.content
          .filter(b => b.type === 'tool_use')
          .map(async b => {
            const result = await mcp.callTool({ name: b.name, arguments: b.input })
            const text = result.content?.map(c => c.text ?? '').join('') ?? ''
            return { type: 'tool_result', tool_use_id: b.id, content: text }
          })
      )
      messages.push({ role: 'user', content: toolResults })
    }

    const text = response.content.find(b => b.type === 'text')?.text ?? ''
    const images = [...text.matchAll(/https:\/\/themobian\.ai\/feed\?[^\s"')]+/g)].map(m => m[0])
    res.json({ result: text, images })
  } catch (err) {
    res.status(500).json({ error: err.message })
  } finally {
    await mcp?.close?.()
  }
})

app.get('/api/image', async (req, res) => {
  const { url } = req.query
  if (!url?.startsWith('https://themobian.ai/')) {
    return res.status(400).send('Invalid URL')
  }
  try {
    const upstream = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.MOBIAN_API_KEY}` },
    })
    res.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg')
    const buf = await upstream.arrayBuffer()
    res.send(Buffer.from(buf))
  } catch (err) {
    res.status(502).send(err.message)
  }
})

const PORT = process.env.PORT ?? 3001
app.listen(PORT, () => console.log(`API server running on port ${PORT}`))

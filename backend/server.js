import express from 'express'
import cors from 'cors'
import Anthropic from '@anthropic-ai/sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const app = express()
app.use(cors({ origin: process.env.CORS_ORIGIN ?? '*' }))
app.use(express.json())

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

async function getMobianClient() {
  const client = new Client({ name: 'key-brandscope', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(
    new URL(process.env.MOBIAN_MCP_URL),
    { requestInit: { headers: { Authorization: `Bearer ${process.env.MOBIAN_API_KEY}` } } }
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
    mcp = await getMobianClient()
    const { tools: mcpTools } = await mcp.listTools()

    const tools = mcpTools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema ?? { type: 'object', properties: {} },
    }))

    const messages = [{ role: 'user', content: prompt }]

    let response
    while (true) {
      response = await anthropic.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 1024,
        tools,
        messages,
      })

      if (response.stop_reason !== 'tool_use') break

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
    console.error('Request error:', err)
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
    res.send(Buffer.from(await upstream.arrayBuffer()))
  } catch (err) {
    res.status(502).send(err.message)
  }
})

const PORT = process.env.PORT ?? 3001
app.listen(PORT, () => console.log(`Server running on port ${PORT}`))

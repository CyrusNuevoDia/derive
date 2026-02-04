#!/usr/bin/env bun
import { createCLI } from '@bunli/core'
import helloCommand from './commands/hello.js'

const cli = await createCLI({
  name: 'derive',
  version: '0.1.0',
  description: 'A CLI built with Bunli'
})

cli.command(helloCommand)

await cli.run()
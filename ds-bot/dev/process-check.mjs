import { createRequire } from 'node:module'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
// Run after dev/smoke.mjs on an isolated mock bench. Never use a live DSH home.
// node dev/process-check.mjs <bench-name> <port> <out-dir>
const [bench, port, output] = process.argv.slice(2)
if (!bench || !/^[-a-z0-9]+$/.test(bench) || !port || !output) throw new Error('usage: process-check.mjs <bench-name> <port> <out-dir>')
const root=resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const out=resolve(output)
const require=createRequire(root+'/deepseek-harness/package.json')
const {chromium}=require(require.resolve('playwright-core',{paths:[root+'/deepseek-harness/node_modules/.pnpm/node_modules']}))
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN,headless:true})
const page=await browser.newPage({viewport:{width:1350,height:1000}})
const errors=[]; const consoleErrors=[];page.on('console',message=>{if(['error','warning'].includes(message.type()))consoleErrors.push(message.text())});page.on('pageerror',error=>errors.push(error.message))
const home=root+'/.dsh-test-'+bench
let login
const startupDeadline=Date.now()+30000
while (!login && Date.now()<startupDeadline) {
try { login=readFileSync(home+'/web.log','utf8').split('\n').find(line=>line.startsWith('dsh web: '))?.slice('dsh web: '.length).trim() } catch {}
if (!login) await new Promise(resolve=>setTimeout(resolve,300))
}
assert.ok(login, 'the isolated bench must print its login URL')
try {
const auth = await page.request.get(login, { maxRedirects: 0 })
assert.equal(auth.status(), 303, 'the bench login must issue a browser cookie')
const rootResponse = await page.request.get(new URL('.', login).href)
if (rootResponse.status() !== 200) throw new Error('bench index HTTP '+rootResponse.status()+': '+(await rootResponse.text()).slice(0,300))
await page.goto(new URL('.', login).href)
const notice=page.getByRole('dialog').getByRole('button',{name:'Continue'})
await page.addLocatorHandler(notice,()=>notice.click({force:true}))
await page.locator('.bt-tile,.bt-row').first().waitFor({timeout:60000})
const api=async(endpoint,payload={})=>page.evaluate(async([endpoint,payload])=>{const response=await fetch('api/bot',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint,payload})});const data=await response.json();if(!data.ok)throw new Error(data.error.message);return data.value},[endpoint,payload])
const state=await api('state')
const chief=state.bots.find(bot=>bot.id===state.mainBotId)
if (process.argv[5] === '--replay') {
const room=state.rooms.filter(room=>room.name.startsWith('Process verification')).at(-1)
assert.ok(room, 'there must be a previously verified group')
await page.locator('.bt-row[data-room-id="'+room.id+'"]').click()
await page.locator('.bt-process [data-chat-call-id]').first().waitFor({timeout:60000})
const prior=JSON.parse(readFileSync(out+'/ui-check.json','utf8'))
assert.equal(await page.locator('.bt-process [data-chat-call-id]').count(),prior.rowsBefore)
assert.deepEqual(errors,[])
assert.deepEqual(consoleErrors,[])
writeFileSync(out+'/restart-check.json',JSON.stringify({rows:prior.rowsBefore,errors},null,2))
console.log('PASS: group process replays after host restart')
} else {
const bot=await api('create-bot',{name:'ProcessReader'+Date.now(),role:'Research',model:chief.model})
await page.locator(`.bt-row[data-bot-id="${bot.id}"]`).click()
await api('send',{sessionId:bot.id,text:'长任务 2 1'})
await page.locator('[data-chat-call-id]').first().waitFor({timeout:60000})
await page.locator('[data-chat-call-id] [data-disclosure-row], [data-chat-call-id] [data-sample=bash]').first().click()
assert.match(await page.locator('[data-chat-call-id]').first().innerText(),/IN|Input|输入/)
const room=await api('create-room',{name:'Process verification '+Date.now(),members:[chief.id,bot.id],admin:chief.id})
await page.locator(`.bt-row[data-room-id="${room.id}"]`).click()
await api('send',{sessionId:room.id,text:'分步 1'})
await page.locator('.bt-process-member').first().waitFor({timeout:60000})
await page.waitForFunction(()=>document.querySelectorAll('.bt-process [data-chat-call-id]').length>0,{},{timeout:60000})
const deadline=Date.now()+60000
while(Date.now()<deadline){const snapshot=await api('state');if(!snapshot.work.rooms[room.id]?.length && !snapshot.activity[bot.id])break;await page.waitForTimeout(500)}
await page.waitForFunction(()=>document.querySelector('.bt-process-member [data-turn-process]'),{},{timeout:60000})
const rowsBefore=await page.locator('.bt-process [data-chat-call-id]').count()
assert.ok(rowsBefore>0)
mkdirSync(out,{recursive:true})
await page.screenshot({path:out+'/group.png'})
await page.reload()
await page.locator('[data-chat-call-id]').first().waitFor({timeout:60000})
assert.equal(await page.locator('.bt-process [data-chat-call-id]').count(),rowsBefore)
const process=await page.locator('.bt-process-member').first().innerText()
writeFileSync(out+'/ui-check.json',JSON.stringify({rowsBefore,afterReload:await page.locator('.bt-process [data-chat-call-id]').count(),errors,process},null,2))
assert.deepEqual(errors,[])
assert.deepEqual(consoleErrors,[])
await api('send',{sessionId:room.id,text:'思考'});
const thinking=page.locator('.bt-process [data-variant=think]').last();await thinking.waitFor({timeout:60000});await thinking.locator('[data-disclosure-row]').click();assert.match(await thinking.innerText(),/先核对群聊/);
await page.screenshot({path:out+'/group-reasoning.png'});
console.log('PASS: Bot details, group process, reload and no browser errors')
}
} catch (error) {
mkdirSync(out,{recursive:true})
console.log(JSON.stringify({errors,consoleErrors}));
await page.screenshot({path:out+'/failure.png'}).catch(()=>{})
throw error
} finally { await browser.close() }

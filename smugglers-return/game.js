import {renderer} from './renderer.js';

// Windows can expose Sony's HID layout when the browser has no standard mapping.
function readController(pad) {
    if (!pad || pad.connected === false) return null;
    const raw = pad.mapping !== 'standard';
    if (raw && !(pad.mapping === '' && /dualsense|054c.*0ce6/i.test(pad.id)
        && pad.buttons.length >= 14 && pad.axes.length >= 6)) return null;

    const pressed = index => !!pad.buttons[index]?.pressed;
    const stick = index => Math.abs(pad.axes[index] ?? 0) > .12 ? pad.axes[index] : 0;
    const trigger = (button, axis) => raw
        ? Math.max(0, Math.min(1, (pad.axes[axis] + 1) / 2))
        : pad.buttons[button]?.value ?? 0;
    const hat = pad.axes[9];
    const direction = raw && hat >= -1 && hat <= 1 ? Math.round((hat + 1) * 3.5) : -1;
    return {
        index: pad.index,
        confirm: pressed(raw ? 1 : 0), back: pressed(raw ? 2 : 1),
        reset: pressed(raw ? 0 : 2), menu: pressed(3), pause: pressed(9),
        throttle: trigger(7, 4), brake: trigger(6, 3),
        horizontal: stick(0), vertical: stick(1), lookX: stick(2), lookY: stick(raw ? 5 : 3),
        menuAxis: raw ? Number([3,4,5].includes(direction)) - Number([7,0,1].includes(direction))
            : Number(pressed(13)) - Number(pressed(12)),
    };
}

// WebHID supplies the report ID separately from its DataView payload.
function dualSenseInput(reportId, data) {
    const simple = reportId === 1 && [9, 77].includes(data.byteLength);
    const extendedBluetooth = reportId === 0x31 && data.byteLength === 77;
    if (!simple && !extendedBluetooth && !(reportId === 1 && data.byteLength === 63)) return null;
    const offset = extendedBluetooth ? 1 : 0;
    const bytes = new Uint8Array(data.buffer, data.byteOffset + offset, 9);
    if (!bytes.some(Boolean)) return null;
    const stick = i => {
        const value = (bytes[i] - 127.5) / 127.5;
        return Math.sign(value) * Math.max(0, (Math.abs(value) - .12) / .88);
    };
    const face = bytes[simple ? 4 : 7], hat = face & 15;
    return {
        index: 'dualsense-hid', confirm: !!(face & 32), back: !!(face & 64),
        reset: !!(face & 16), menu: !!(face & 128), pause: !!(bytes[simple ? 5 : 8] & 32),
        brake: bytes[simple ? 7 : 4] / 255, throttle: bytes[simple ? 8 : 5] / 255,
        horizontal: stick(0), vertical: stick(1), lookX: stick(2), lookY: stick(3),
        menuAxis: [7,0,1].includes(hat) ? -1 : Number([3,4,5].includes(hat)),
    };
}

function connectDualSense(button) {
    let device, input = null;
    if (!navigator.hid) return () => null;
    button.hidden = false;
    const filter = {vendorId: 0x054c, productId: 0x0ce6, usagePage: 1, usage: 5};
    function receive(event) {
        if (event.device !== device) return;
        const reading = dualSenseInput(event.reportId, event.data);
        if (reading) {
            if (!input) button.textContent = 'DualSense connected';
            input = reading;
        }
    }
    async function open(selected) {
        device = selected;
        input = null;
        button.disabled = true;
        try {
            selected.addEventListener('inputreport', receive);
            if (!selected.opened) await selected.open();
            if (device === selected && !input) button.textContent = 'Press Cross on DualSense';
        } catch {
            if (device === selected) {
                device = null;
                button.disabled = false;
                button.textContent = 'Retry DualSense connection';
            }
            selected.removeEventListener('inputreport', receive);
        }
    }
    button.onclick = async () => {
        try {
            const [selected] = await navigator.hid.requestDevice({filters: [filter]});
            if (selected) await open(selected);
        } catch { button.textContent = 'Retry DualSense connection'; }
    };
    navigator.hid.addEventListener('disconnect', event => {
        if (event.device !== device) return;
        device.removeEventListener('inputreport', receive);
        device = null;
        input = null;
        button.disabled = false;
        button.textContent = 'Connect DualSense';
    });
    navigator.hid.addEventListener('connect', event => {
        if (!device && event.device.vendorId === filter.vendorId && event.device.productId === filter.productId)
            void open(event.device);
    });
    return () => input;
}

async function launch(){
    const {instance}=await WebAssembly.instantiateStreaming(fetch('./game.wasm'));
    const api=instance.exports;
    api.web_start();
    const render=renderer(document.querySelector('canvas'),api);
    const title=document.querySelector('main'), button=document.querySelector('button'), hud=document.querySelector('pre');
    const hidController=connectDualSense(document.querySelector('#connect-dualsense'));
    const text=api.web_buffer(4096), pcm=api.web_buffer(4096*4);
    const decoder=new TextDecoder(), keys=new Set();
    let audio, scheduled=0, playing=false, releaseConfirm=false, last=0, padIndex=null;
    let titleConfirmHeld=false;
    function unlockAudio(){
        audio??=new AudioContext();
        if(audio.state==='suspended') audio.resume().catch(()=>{});
    }
    function sound(){
        if(audio?.state!=='running') return;
        scheduled=Math.max(scheduled,audio.currentTime);
        while(scheduled<audio.currentTime+.12){
            const frames=4096;
            api.sr_tvos_render_audio(pcm,frames,2);
            const samples=new Int16Array(api.memory.buffer,pcm,frames*2);
            const buffer=audio.createBuffer(2,frames,48000);
            for(let c=0;c<2;c++){
                const channel=buffer.getChannelData(c);
                for(let i=0;i<frames;i++) channel[i]=samples[i*2+c]/32768;
            }
            const source=audio.createBufferSource();
            source.buffer=buffer;source.connect(audio.destination);source.start(scheduled);
            scheduled+=buffer.duration;
        }
    }
    function start(){
        playing=true;releaseConfirm=true;title.hidden=true;hud.hidden=false;
    }
    button.disabled=false;button.textContent='Start · A / Cross / Enter';
    button.onclick=()=>{unlockAudio();start();};
    addEventListener('pointerdown',unlockAudio);
    addEventListener('keydown',e=>{
        if(['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Space','Tab','Enter'].includes(e.code)) e.preventDefault();
        keys.add(e.code);unlockAudio();
    });
    addEventListener('keyup',e=>keys.delete(e.code));
    addEventListener('blur',()=>keys.clear());
    document.addEventListener('visibilitychange',()=>{
        keys.clear();last=0;
        if(document.hidden){api.sr_tvos_suspend();audio?.suspend();}
        else {api.sr_tvos_resume();if(audio) unlockAudio();}
    });
    function frame(now){
        if(!document.hidden){
            const pads=Array.from(navigator.getGamepads?.() ?? [], readController).filter(Boolean);
            const hid=hidController();
            if(hid) pads.unshift(hid);
            const current=pads.find(p=>p.index===padIndex);
            // A/Cross claims control even if an idle virtual controller occupies slot zero.
            const pad=(current?.confirm ? current : pads.find(p=>p.confirm)) ?? current ?? pads[0];
            padIndex=pad?.index??null;
            const key=name=>Number(keys.has(name));
            const confirm=pad?.confirm||key('Enter')||key('Space');
            if(!playing && confirm && !titleConfirmHeld){start();unlockAudio();}
            titleConfirmHeld=!!confirm;
            if(!confirm) releaseConfirm=false;
            if(playing){
                const lx=pad?.horizontal||key('ArrowRight')-key('ArrowLeft');
                const ly=pad?.vertical||key('ArrowDown')-key('ArrowUp');
                api.sr_tvos_set_controls(!!pad,-lx,Math.max(pad?.throttle??0,key('ArrowUp')),
                    Math.max(pad?.brake??0,key('ArrowDown')),confirm&&!releaseConfirm,
                    pad?.reset||key('KeyR'),pad?.menuAxis||ly,
                    pad?.menu||key('Tab'),pad?.back||key('Escape'),pad?.pause||key('Escape'),
                    lx,-ly,pad?.lookX??0,-(pad?.lookY??0));
                api.sr_tvos_advance(last?Math.min((now-last)/1000,.1):0);
                const menu=api.sr_tvos_menu_text(text,4096);
                render();
                const bytes=new Uint8Array(api.memory.buffer,text,4096);
                const label=decoder.decode(bytes.subarray(0,bytes.indexOf(0)));
                if(hud.textContent!==label) hud.textContent=label;
                hud.hidden=!label;
                hud.classList.toggle('menu',!!menu);
                sound();
                if(api.sr_tvos_take_exit_request()){playing=false;title.hidden=false;hud.hidden=true;}
            }
            last=now;
        }
        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
}
launch().catch(error=>{document.querySelector('button').textContent=error.message;console.error(error);});

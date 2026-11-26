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

async function launch(){
    const {instance}=await WebAssembly.instantiateStreaming(fetch('./game.wasm'));
    const api=instance.exports;
    api.web_start();
    const render=renderer(document.querySelector('canvas'),api);
    const title=document.querySelector('main'), button=document.querySelector('button'), hud=document.querySelector('pre');
    const telemetry=api.web_buffer(80), text=api.web_buffer(4096), pcm=api.web_buffer(4096*4);
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
                api.sr_tvos_get_telemetry(telemetry);
                const menu=api.sr_tvos_menu_text(text,4096);
                render(new Float32Array(api.memory.buffer,telemetry,18).slice(),!!menu);
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

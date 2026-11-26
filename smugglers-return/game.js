import {renderer} from './renderer.js';

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
            const pads=Array.from(navigator.getGamepads?.()??[]).filter(p=>p?.mapping==='standard');
            const pad=pads.find(p=>p.index===padIndex)??pads[0];padIndex=pad?.index??null;
            const down=i=>!!pad?.buttons[i]?.pressed;
            const axis=i=>Math.abs(pad?.axes[i]??0)>.12?pad.axes[i]:0;
            const key=name=>Number(keys.has(name));
            const confirm=down(0)||key('Enter')||key('Space');
            if(!playing && confirm && !titleConfirmHeld){start();unlockAudio();}
            titleConfirmHeld=!!confirm;
            if(!confirm) releaseConfirm=false;
            if(playing){
                const lx=axis(0)||key('ArrowRight')-key('ArrowLeft');
                const ly=axis(1)||key('ArrowDown')-key('ArrowUp');
                api.sr_tvos_set_controls(!!pad,-lx,Math.max(pad?.buttons[7]?.value??0,key('ArrowUp')),
                    Math.max(pad?.buttons[6]?.value??0,key('ArrowDown')),confirm&&!releaseConfirm,
                    down(2)||key('KeyR'),Number(down(13))-Number(down(12))||ly,
                    down(3)||key('Tab'),down(1)||key('Escape'),down(9)||key('Escape'),
                    lx,-ly,axis(2),-axis(3));
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

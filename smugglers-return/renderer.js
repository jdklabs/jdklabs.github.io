// The simulation supplies world-space metres, box transforms and objective geometry.
const cross = ([a,b,c], [x,y,z]) => [b*z-c*y,c*x-a*z,a*y-b*x];
const dot = (a,b) => a.reduce((sum,v,i) => sum+v*b[i],0);
const unit = a => a.map(v => v/Math.hypot(...a));
const surfaces = [[.35,.31,.26],[.43,.45,.23],[.48,.46,.40],[.31,.26,.17],
    [.20,.48,.52],[.80,.68,.42],[.86,.90,.92],[.59,.77,.83]];
const faces = [[0,1,3,2],[4,6,7,5],[0,4,5,1],[2,3,7,6],[0,2,6,4],[1,5,7,3]];
const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];

function boxes(parts) {
    const vertices = [];
    for (let i=0; i<parts.length; i+=17) {
        const [x,y,z,h,p,r,cx,cy,cz,w,t,d,red,green,blue,yaw,spin] = parts.subarray(i,i+17);
        const [ch,cp,cr,ca,cs] = [h,-p,r,yaw,spin].map(Math.cos);
        const [sh,sp,sr,sa,ss] = [h,-p,r,yaw,spin].map(Math.sin);
        const corners = Array.from({length:8}, (_,k) => {
            const a=k&1?w:-w, b=k&2?t:-t, c=k&4?d:-d;
            const wheelZ=ss*b+cs*c, u=ca*a+sa*wheelZ+cx;
            const v=cs*b-ss*c+cy, q=-sa*a+ca*wheelZ+cz;
            const rolledX=cr*u-sr*v, rolledY=sr*u+cr*v, pitchedZ=sp*rolledY+cp*q;
            return [x+ch*rolledX+sh*pitchedZ,y+cp*rolledY-sp*q,z-sh*rolledX+ch*pitchedZ];
        });
        faces.forEach(([a,b,c,d],face) => {
            const light=[.8,.86,.55,1,.68,.74][face];
            for(const k of [a,b,c,c,d,a]) vertices.push(...corners[k],red*light,green*light,blue*light,1);
        });
    }
    return vertices;
}

export function renderer(canvas, api) {
    const gl = canvas.getContext('webgl2',{alpha:false});
    if (!gl) throw Error('WebGL 2 is required to play.');
    const program = gl.createProgram();
    for(const [type,source] of [[gl.VERTEX_SHADER,`#version 300 es
        in vec3 position; in vec4 color; uniform mat4 camera; out vec4 tint;
        void main(){gl_Position=camera*vec4(position,1.); tint=color;}`],
        [gl.FRAGMENT_SHADER,`#version 300 es
        precision mediump float; in vec4 tint; out vec4 pixel;
        void main(){pixel=tint;}`]]) {
        const shader=gl.createShader(type);
        gl.shaderSource(shader,source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
        gl.attachShader(program,shader);
    }
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const matrix=gl.getUniformLocation(program,'camera');
    const pos=gl.getAttribLocation(program,'position'), color=gl.getAttribLocation(program,'color');
    gl.enableVertexAttribArray(pos); gl.enableVertexAttribArray(color);
    const buffer=()=>({id:gl.createBuffer(),count:0});
    function upload(buf,data) {
        gl.bindBuffer(gl.ARRAY_BUFFER,buf.id);
        gl.bufferData(gl.ARRAY_BUFFER,data instanceof Float32Array?data:new Float32Array(data),gl.DYNAMIC_DRAW);
        buf.count=data.length/7;
    }
    function draw(buf) {
        gl.bindBuffer(gl.ARRAY_BUFFER,buf.id);
        gl.vertexAttribPointer(pos,3,gl.FLOAT,false,28,0);
        gl.vertexAttribPointer(color,4,gl.FLOAT,false,28,12);
        gl.drawArrays(gl.TRIANGLES,0,buf.count);
    }
    const sample=api.web_buffer(8), parts=api.web_buffer(512*68);
    let propCapacity=2048, props=api.web_buffer(propCapacity*68);
    const geometry=api.web_buffer(2048*28), basis=api.web_buffer(64);
    const floats=(ptr,n)=>new Float32Array(api.memory.buffer,ptr,n);
    function ground(x,z) {
        api.sr_tvos_sample_world(sample,x,z);
        return floats(sample,1)[0];
    }
    const terrain=buffer(), scenery=buffer(), vehicles=buffer(), goal=buffer();
    let previousCell='';
    function landscape(x,z) {
        const cx=Math.round(x/64)*64, cz=Math.round(z/64)*64;
        const cell=[cx,cz,api.sr_tvos_terrain_key()].join('/');
        if(cell===previousCell) return;
        previousCell=cell;
        const points=[], mesh=[], radius=32, step=8, stride=2*radius+1;
        for(let j=-radius;j<=radius;j++) for(let i=-radius;i<=radius;i++) {
            const px=cx+i*step,pz=cz+j*step,h=ground(px,pz);
            const rgb=surfaces[new Uint32Array(api.memory.buffer,sample+4,1)[0]];
            points.push([px,h,pz,...rgb,1]);
        }
        for(let j=0;j<stride-1;j++) for(let i=0;i<stride-1;i++){
            const a=j*stride+i,b=a+1,c=a+stride,d=c+1;
            const shade=Math.min(1.15,Math.max(.65,.94+(points[a][1]-points[b][1])*.035));
            for(const k of [a,b,c,c,b,d]){
                const [x,y,z,r,g,b]=points[k];
                mesh.push(x,y,z,r*shade,g*shade,b*shade,1);
            }
        }
        upload(terrain,mesh);
        let count=api.sr_tvos_scenery(cx,cz,props,propCapacity);
        if(count>propCapacity){
            propCapacity=count; props=api.web_buffer(count*68);
            count=api.sr_tvos_scenery(cx,cz,props,count);
        }
        upload(scenery,boxes(floats(props,count*17)));
    }
    let boom;
    return function render(t,menu) {
        if(!menu || !boom) boom=t.slice(14,17);
        const [x,y,z,h]=t.slice(6,10), [side,up,back]=boom;
        const sin=Math.sin(h), cos=Math.cos(h);
        const eye=[x-sin*back-cos*side,y+1.5+up,z-cos*back+sin*side];
        eye[1]=Math.max(eye[1],ground(eye[0],eye[2])+2);
        const forward=unit([x+7*sin-eye[0],y+1.5-eye[1],z+7*cos-eye[2]]);
        const right=unit(cross(forward,[0,1,0])), vertical=cross(right,forward);
        api.sr_tvos_view_plane(...forward,-dot(forward,eye));
        const scale=Math.min(devicePixelRatio,1.5);
        const w=Math.max(1,Math.round(canvas.clientWidth*scale)),height=Math.max(1,Math.round(canvas.clientHeight*scale));
        if(canvas.width!==w || canvas.height!==height){canvas.width=w;canvas.height=height;}
        gl.viewport(0,0,w,height);
        const sx=1.73*height/w,sy=1.73,depth=1.001, translation=dot(forward,eye);
        const camera=[];
        for(let i=0;i<3;i++) camera.push(right[i]*sx,vertical[i]*sy,forward[i]*depth,forward[i]);
        camera.push(-dot(right,eye)*sx,-dot(vertical,eye)*sy,-translation*depth-.4,-translation);
        gl.uniformMatrix4fv(matrix,false,camera);
        gl.clearColor(.58,.76,.84,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        landscape(x,z); draw(terrain); draw(scenery);
        const count=api.sr_tvos_scene_parts(parts,512);
        upload(vehicles,boxes(floats(parts,count*17))); draw(vehicles);
        floats(basis,6).set([...right,...vertical]);
        const n=api.sr_tvos_cargo_geometry(basis,basis+12,geometry,2048);
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
        upload(goal,floats(geometry,n*7)); draw(goal);
        floats(basis,16).set(camera);
        const pointer=api.sr_tvos_goal_vertices(basis,w,height,geometry,2048);
        gl.disable(gl.DEPTH_TEST); gl.uniformMatrix4fv(matrix,false,identity);
        upload(goal,floats(geometry,pointer*7)); draw(goal);
        gl.disable(gl.BLEND);
    };
}

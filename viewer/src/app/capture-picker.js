import './capture-picker.css';

// Optional overview for camera-only tours with many capture locations.
export function capturePicker({nav, getCurrent, go}) {
  const dialog=document.createElement('dialog');dialog.className='capture-picker';
  const head=document.createElement('header');
  const title=document.createElement('h2');title.id='capture-picker-title';title.textContent=`촬영 지점 ${nav.nodes.length}곳`;
  dialog.setAttribute('aria-labelledby',title.id);
  const close=document.createElement('button');close.textContent='닫기';close.onclick=()=>dialog.close();head.append(title,close);dialog.append(head);
  const content=document.createElement('div');content.className='capture-picker-content';dialog.append(content);
  const buttons=new Map();
  for(const room of nav.rooms.values()) {
    const section=document.createElement('section');const heading=document.createElement('h3');heading.textContent=room.name;section.append(heading);
    const grid=document.createElement('div');grid.className='capture-picker-grid';section.append(grid);
    for(const node of room.nodes) {
      const button=document.createElement('button');button.type='button';
      if(node.thumbnail){const img=document.createElement('img');img.src=node.thumbnail;img.alt='';img.loading='lazy';button.append(img);}
      const label=document.createElement('span');label.textContent=node.label||node.id;button.append(label);
      button.onclick=()=>{dialog.close();go(node.id);};grid.append(button);buttons.set(node.id,button);
    }
    content.append(section);
  }
  dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
  document.body.append(dialog);
  return ()=>{for(const [id,b] of buttons)b.setAttribute('aria-current',String(id===getCurrent()?.id));dialog.showModal();};
}

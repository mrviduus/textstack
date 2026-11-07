# Original 12x12 pixel icons for the TextStack docs site. Edit the grids, run: python3 gen.py
# Palette is a placeholder - swap for TextStack brand colors.
P={'k':'#1f2430','w':'#ffffff','l':'#9aa3b5','a':'#e8590c','d':'#3b4252','g':'#40c057','b':'#4dabf7'}
I={
"start-here":["............",".kkkk..kkkk.","kwwwwkkwwwwk","kwllwkkwllwk","kwwwwkkwwwwk","kwllwkkwllwk","kwwwwkkwwwwk","kwllwkkwllwk","kwwwwkkwwwwk","kkkkkkkkkkkk",".aaaa..aaaa.","............"],
"self-host":["............",".kkkkkkkkkk.",".kddddddddk.",".kdgdaddddk.",".kddddddddk.",".kkkkkkkkkk.",".kddddddddk.",".kdgdaddddk.",".kddddddddk.",".kkkkkkkkkk.","...k....k...","..kkk..kkk.."],
"architecture":["....kkkk....","....kaak....","....kaak....","....kkkk....",".....kk.....","..kkkkkkkk..","..k......k..","kkkk....kkkk","kbbk....kbbk","kbbk....kbbk","kkkk....kkkk","............"],
"contribute":["............","..kk....kk..",".kaak..kaak.","kaawaaaaaaak","kaaaaaaaaaak","kaaaaaaaaaak",".kaaaaaaaak.","..kaaaaaak..","...kaaaak...","....kaak....",".....kk.....","............"],
}
for n,rows in I.items():
    r=''.join(f'<rect x="{x}" y="{y}" width="1" height="1" fill="{P[c]}"/>' for y,row in enumerate(rows) for x,c in enumerate(row) if c!='.')
    open(n+'.svg','w').write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="96" height="96" shape-rendering="crispEdges">{r}</svg>')

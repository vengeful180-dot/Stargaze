"""node_expr.py - a small expression builder for Cycles shader node trees (Blender 5.2): arithmetic on sockets and
Python numbers, so a material reads like the formula it implements. Every helper returns an OUTPUT socket.

    import node_expr; g = node_expr.G(material.node_tree)
    col = g.vscale(g.vmul(base, g.comb(wr, 1.0, wb)), g.mul(tone, 0.87))      # a 359-node floor material stayed readable
    blender -b --factory-startup --python-exit-code 1 -P node_expr.py -- --self-test

From the oak floor (D:/experiment/floor/nodes.py, 2026-10-03). Sockets, Python numbers and tuples mix freely in
every argument; `g.attr(name)` reads a FACE-domain FLOAT_COLOR attribute (Vector = RGB, Alpha = 4th) - per-board
tone / gloss / seed carried on the mesh survive appending into another scene.
"""
import sys


class G:
    def __init__(self, nt):
        self.nt = nt
        self.n = 0

    # ---------------------------------------------------------------------------------------- plumbing
    def node(self, kind, **props):
        nd = self.nt.nodes.new(kind)
        for k, v in props.items():
            setattr(nd, k, v)
        nd.location = (200 * (self.n // 40), -120 * (self.n % 40))
        self.n += 1
        return nd

    def _in(self, sock, x):
        if x is None:
            return
        if isinstance(x, (int, float)):
            sock.default_value = float(x)
        elif isinstance(x, (tuple, list)):
            sock.default_value = tuple(float(v) for v in x)
        else:
            self.nt.links.new(x, sock)

    # ---------------------------------------------------------------------------------------- scalar math
    def m(self, op, a=None, b=None, c=None, clamp=False):
        nd = self.node("ShaderNodeMath", operation=op, use_clamp=clamp)
        for i, x in enumerate((a, b, c)):
            self._in(nd.inputs[i], x)
        return nd.outputs[0]

    def add(self, a, b):
        return self.m("ADD", a, b)

    def sub(self, a, b):
        return self.m("SUBTRACT", a, b)

    def mul(self, a, b):
        return self.m("MULTIPLY", a, b)

    def div(self, a, b):
        return self.m("DIVIDE", a, b)

    def mad(self, a, b, c):
        """a * b + c"""
        return self.m("MULTIPLY_ADD", a, b, c)

    def mn(self, a, b):
        return self.m("MINIMUM", a, b)

    def mx(self, a, b):
        return self.m("MAXIMUM", a, b)

    def absf(self, a):
        return self.m("ABSOLUTE", a)

    def clamp01(self, a):
        return self.m("ADD", a, 0.0, clamp=True)

    def gt(self, a, b):
        return self.m("GREATER_THAN", a, b)

    def lt(self, a, b):
        return self.m("LESS_THAN", a, b)

    def exp(self, a):
        return self.m("EXPONENT", a)

    def sqrt(self, a):
        return self.m("SQRT", a)

    def sin(self, a):
        return self.m("SINE", a)

    def cos(self, a):
        return self.m("COSINE", a)

    def floor(self, a):
        return self.m("FLOOR", a)

    def fract(self, a):
        return self.m("FRACT", a)

    def lerp(self, a, b, t):
        """a + (b - a) t"""
        return self.add(a, self.mul(self.sub(b, a), t))

    def smooth(self, e0, e1, x):
        """smoothstep from e0 to e1 (e1 < e0 gives a falling edge)"""
        nd = self.node("ShaderNodeMapRange", interpolation_type="SMOOTHSTEP", clamp=True)
        self._in(nd.inputs["Value"], x)
        if e1 >= e0:
            nd.inputs["From Min"].default_value, nd.inputs["From Max"].default_value = e0, e1
            nd.inputs["To Min"].default_value, nd.inputs["To Max"].default_value = 0.0, 1.0
        else:
            nd.inputs["From Min"].default_value, nd.inputs["From Max"].default_value = e1, e0
            nd.inputs["To Min"].default_value, nd.inputs["To Max"].default_value = 1.0, 0.0
        return nd.outputs["Result"]

    def remap(self, x, a0, a1, b0, b1, clamp=True):
        nd = self.node("ShaderNodeMapRange", interpolation_type="LINEAR", clamp=clamp)
        self._in(nd.inputs["Value"], x)
        for k, v in (("From Min", a0), ("From Max", a1), ("To Min", b0), ("To Max", b1)):
            self._in(nd.inputs[k], v)
        return nd.outputs["Result"]

    # ---------------------------------------------------------------------------------------- vectors / colours
    def v(self, op, a, b=None, scale=None):
        nd = self.node("ShaderNodeVectorMath", operation=op)
        self._in(nd.inputs[0], a)
        if b is not None:
            self._in(nd.inputs[1], b)
        if scale is not None:
            self._in(nd.inputs["Scale"], scale)
        return nd.outputs["Value"] if op in ("DOT_PRODUCT", "LENGTH", "DISTANCE") else nd.outputs["Vector"]

    def vmul(self, a, b):
        return self.v("MULTIPLY", a, b)

    def vadd(self, a, b):
        return self.v("ADD", a, b)

    def vsub(self, a, b):
        return self.v("SUBTRACT", a, b)

    def vscale(self, a, s):
        return self.v("SCALE", a, scale=s)

    def vlerp(self, a, b, t):
        return self.vadd(a, self.vscale(self.vsub(b, a), t))

    def comb(self, x, y, z):
        nd = self.node("ShaderNodeCombineXYZ")
        for i, c in enumerate((x, y, z)):
            self._in(nd.inputs[i], c)
        return nd.outputs[0]

    def sep(self, vec):
        nd = self.node("ShaderNodeSeparateXYZ")
        self._in(nd.inputs[0], vec)
        return nd.outputs[0], nd.outputs[1], nd.outputs[2]

    def lum(self, col):
        return self.v("DOT_PRODUCT", col, (0.2126, 0.7152, 0.0722))

    # ---------------------------------------------------------------------------------------- inputs / textures
    def uv(self, name):
        return self.node("ShaderNodeUVMap", uv_map=name).outputs["UV"]

    def attr(self, name):
        nd = self.node("ShaderNodeAttribute", attribute_type="GEOMETRY", attribute_name=name)
        return nd.outputs["Vector"], nd.outputs["Alpha"]

    def texcoord(self, which="Object"):
        return self.node("ShaderNodeTexCoord").outputs[which]

    def noise(self, vec, scale=1.0, detail=2.0, rough=0.5, distortion=0.0, w=None):
        nd = self.node("ShaderNodeTexNoise")
        if w is not None:
            nd.noise_dimensions = "4D"
            self._in(nd.inputs["W"], w)
        self._in(nd.inputs["Vector"], vec)
        nd.inputs["Scale"].default_value = scale
        nd.inputs["Detail"].default_value = detail
        nd.inputs["Roughness"].default_value = rough
        nd.inputs["Distortion"].default_value = distortion
        return nd.outputs["Fac"]

    def white(self, vec):
        nd = self.node("ShaderNodeTexWhiteNoise", noise_dimensions="3D")
        self._in(nd.inputs["Vector"], vec)
        return nd.outputs["Value"]

    def voronoi(self, vec, scale=1.0, feature="F1", randomness=1.0, out="Distance"):
        nd = self.node("ShaderNodeTexVoronoi", feature=feature)
        self._in(nd.inputs["Vector"], vec)
        nd.inputs["Scale"].default_value = scale
        nd.inputs["Randomness"].default_value = randomness
        return nd.outputs[out]

    def bump(self, height, strength=1.0, distance=1.0, normal=None):
        nd = self.node("ShaderNodeBump")
        nd.inputs["Strength"].default_value = strength
        nd.inputs["Distance"].default_value = distance
        self._in(nd.inputs["Height"], height)
        if normal is not None:
            self._in(nd.inputs["Normal"], normal)
        return nd.outputs["Normal"]


# ---------------------------------------------------------------------------------------------------- self-test
def selftest():
    """build a tiny tree in a throwaway material: every helper must make the node, values and links the formula says"""
    import bpy
    m = bpy.data.materials.new("_node_expr_selftest")
    try:
        g = G(m.node_tree)
        a = g.mad(2.0, 3.0, 4.0)
        assert a.node.bl_idname == "ShaderNodeMath" and a.node.operation == "MULTIPLY_ADD", "mad node"
        assert [a.node.inputs[i].default_value for i in range(3)] == [2.0, 3.0, 4.0], "mad values"
        rise, fall = g.smooth(0.2, 0.8, a), g.smooth(0.8, 0.2, a)
        assert rise.node.inputs["Value"].links[0].from_socket == a, "smooth must link its input"
        assert (rise.node.inputs["To Min"].default_value, rise.node.inputs["To Max"].default_value) == (0.0, 1.0)
        assert (fall.node.inputs["To Min"].default_value, fall.node.inputs["To Max"].default_value) == (1.0, 0.0),             "a falling smoothstep (e1 < e0) must map 1 -> 0"
        v = g.vlerp((1.0, 0.0, 0.0), (0.0, 0.0, 1.0), rise)
        assert v.node.bl_idname == "ShaderNodeVectorMath" and v.node.operation == "ADD", "vlerp = a + (b - a) t"
        d = g.lum(v)
        assert d.node.operation == "DOT_PRODUCT" and d.name == "Value", "lum must return the scalar output"
        vec, alpha = g.attr("board_tone")
        assert vec.node.attribute_type == "GEOMETRY" and vec.node.attribute_name == "board_tone"
        nb = len(m.node_tree.nodes)
        try:                                              # a socket of the wrong kind must not pass silently
            g._in(a.node.inputs[0], "not a socket")
            raised = False
        except Exception:                                 # noqa: BLE001
            raised = True
        assert raised, "feeding a string must raise"
        print(f"NODE_EXPR SELF-TEST OK ({nb} nodes built)")
    finally:
        bpy.data.materials.remove(m)


if __name__ == "__main__" and "--self-test" in sys.argv:
    selftest()

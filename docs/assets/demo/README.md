# TermLoom Math Rendering Test

This disposable workspace is opened by the demo script. Click this Markdown
file in **Files** and inspect the native character-cell preview on the right.

The examples below intentionally exercise inline and display LaTeX. They are
kept together so resizing and scrolling the preview tests the complete layout.

## Inline formulas

Short inline math should flow with prose: $E = mc^2$, $e^{i\pi}+1=0$, and
$(a+b)^2=a^2+2ab+b^2$.

Subscripts and superscripts stay compact: $a_0+a_1x+a_2x^2$, $x_i^2$, and
$T_{n+1}=T_n+1$.

Greek letters and operators remain readable: $\alpha+\beta+\gamma$,
$\Delta x\to 0$, $\partial_t u$, and $\nabla^2u$.

Roots, fractions, and limits can appear in a sentence: $\sqrt{x^2+y^2}$,
$\frac{a}{b}$, $\left(\frac{a}{b}\right)^2$, and
$\lim_{x\to 0}\frac{\sin x}{x}=1$.

Sums and products also share the baseline: $\sum_{k=1}^{n} k$,
$\prod_{k=1}^{n} k$, $\mathbb{R}\subset\mathbb{C}$, and
$\vec{v}\cdot\vec{w}$.

Relations and named functions stay in the same line: $a\neq b$, $x\ge y$,
$a\times b$, $\infty$, and $\sin^2 x+\cos^2 x=1$.

## Display formulas

### Identities and polynomials

$$
e^{i\pi}+1=0
$$

$$
x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}
$$

$$
(a+b)^3=a^3+3a^2b+3ab^2+b^3
$$

### Fractions, roots, and calculus

$$
\int_0^1 x^2\,dx=\frac{1}{3}
$$

$$
\lim_{x\to 0}\frac{\sin x}{x}=1
$$

$$
\partial_t u=\alpha\nabla^2u
$$

$$
\left(\frac{a}{b}\right)^2=\frac{a^2}{b^2}
$$

### Sums and products

$$
\sum_{k=1}^{n} k=\frac{n(n+1)}{2}
$$

$$
\prod_{k=1}^{n} k=n!
$$

### Binomials, derivatives, and nested operators

$$
\binom{n}{k}
$$

$$
\overbrace{a+b}^{sum}
$$

$$
\underbrace{x+y}_{total}
$$

$$
\frac{d}{dx}x^n=nx^{n-1}
$$

$$
\sum_{i=1}^{m}\sum_{j=1}^{n}a_{ij}
$$

$$
\begin{pmatrix}
1&0\\
0&1
\end{pmatrix}
$$

### Cases and matrices

$$
\begin{cases}
x&x>0\\
-x&x\le 0
\end{cases}
$$

$$
\begin{bmatrix}
a&b\\
c&d
\end{bmatrix}
$$

$$
\mathbb{R}\subset\mathbb{C}
$$

### A mixed paragraph

The quadratic discriminant $\Delta=b^2-4ac$ controls the roots. For a vector
$\vec{v}$ and scalar $\lambda$, the scaled vector is $\lambda\vec{v}$, while
the Euclidean norm is $\sqrt{v_1^2+v_2^2}$. This paragraph deliberately places
several formulas close together to test wrapping and baseline alignment.

![Hello World PNG](hello-world.png)

![Hello World GIF](hello-world.gif)

<video controls>
  <source src="hello-world-laser.mp4" type="video/mp4">
</video>

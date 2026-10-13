# purifig

A print-accurate canvas for the purification figure — the SEC trace, the gel
beside it, and the balance sheet that says what came off the column — with the
gel handled as evidence rather than as a picture.

```bash
python3 purifig_server.py
```

then open <http://127.0.0.1:8778>, or double-click `run_mac.command`
(`run_windows.bat` on Windows), which stops a copy still running on the port,
starts the server and opens the page. The canvas is dependency-free and will open a
PNG dropped on it; the server adds 16-bit TIFFs, lane finding, densitometry and
chromatography exports, and needs `numpy`, `pillow` and `tifffile`. The dot in
the toolbar is green when the backend is reachable.

The document is measured in **millimeters** and the SVG viewBox is in mm, so the
page you lay out is what exports at journal size. Font sizes are in points.
Every export carries live text — PDF, SVG and the figure in a protocol document
all open with editable labels, not outlines.

## The panels

**Gel / blot** — a scan, a lane count, a ladder, and the record of what was done
to it.
**Western blot** — the same, holding both pictures an imager takes of a
membrane: the chemiluminescence, and the white-light image the prestained ladder
is read from. It can show only the sizes each antibody is about, as strips.
**Quantification** — bands measured on replicate blots, each divided by its
loading control and expressed relative to a control lane, drawn as bars with a
point per blot.
**Construct** — what was expressed: the tag, the protease site and the protein,
drawn to scale in residues, with what the band should weigh and what it should
weigh once cleaved.
**Chromatogram** — a UNICORN export or a CSV, with fractions, V₀, a calibration
and peak labels. Generic enough for the IMAC and the IEX steps too.
**Purification table** — step, protein, purity, yield. The numbers a reviewer
looks for first, in the one place they are easy to check, and mostly not typed:
see **The table fills itself in** below.
**Boxes, arrows and panel letters** for the flow scheme along the top.
**A brace** (`3`) drawn between a chromatogram and a gel — either way round — so
"these fractions are those lanes" is stated rather than left to horizontal
alignment — and, once it
is drawn, acted on: the gel's fraction lanes say which fractions ran, and the
trace shades those volumes and no others.

## Keys

| | |
|---|---|
| `g` `w` `c` | gel · western blot · chromatogram |
| `p` `d` `q` | purification table · A₂₈₀ table · quantification |
| `s` | construct diagram |
| `n` `t` `a` | box · text · panel letter |
| `1` `2` `3` | arrow · elbow · fractions→lanes brace |
| `0` | zoom to fit |
| `h` | hold to hide the luminescence and see the white light under it |
| ⌘-scroll | zoom · alt-drag or middle-drag pans |
| ctrl-drag | move a panel, from anywhere on it |
| double-click | edit a box's text in place |
| ⌘D ⌘A | duplicate · select all |
| ⌘S ⇧⌘S ⌘O | save the session · save as… · open |
| ⌘Z ⇧⌘Z | undo · redo (⌃Z / ⌃Y on Windows) |

**Undo** keeps the last 80 steps. A step is a whole act rather than an event: a
drag is one, a typed caption is one, a dropped run is one — the panel it creates
and the data loaded into it come back together, and a click that only selects
leaves no step at all. Opening a figure or building the example starts fresh,
because a new document is not an edit of the old one.

It works by snapshotting the document, that being the only description of
"before" which cannot drift out of step with what an edit actually did. The
snapshots are cheap because the two heavy things are shared rather than copied:
strings, which JS shares for free and which is where a gel's rendered PNG lives,
and a trace's point array, which is replaced wholesale whenever it changes and is
frozen on the way into the history to keep that true. Eighty steps of a figure
carrying a 16-bit gel cost well under a megabyte, and undoing a contrast change
puts the old render back without asking the backend for it again.

**Drawing.** The canvas is rebuilt from the document on every mouse move, which
is what keeps the drawn figure and the document from ever disagreeing. The one
thing too big to put through that loop is the pictures: a panel's render is half
a megabyte of base64 and goes into the markup once per strip and per splice, so
a drag was re-parsing several megabytes a frame. On screen the pictures are
therefore blob URLs — the same bytes, behind a forty-character name the browser
has already decoded — while the document keeps the base64, because that is what
a saved session and an exported SVG carry. Exporting puts it back.

## Gels

**Loading.** Drop the scan on the canvas, or use `load image…` to pick it off
disk. A TIFF dropped on the canvas is posted to the backend and read there, at
full depth: the browser never decodes it, so nothing is thrown away. What the
backend can*not* do is open a dropped file by path — a browser will not hand one
out — which is why the bytes go across instead. A PNG or a JPEG is read in the
browser and needs no backend at all, at 8 bits.

A dropped scan's working copy lives in a temp directory for the session. That
path is plumbing, so the record names the file you dropped and says it was
dropped, rather than printing a location nobody can go and look at.

Bit depth is read from the file rather than from the array after processing.
Averaging three 8-bit channels into luminance makes a float array, and calling
that "32-bit" would put a depth in the record the scanner never had.

**Lanes.** Give the lane count and the backend divides the gel into that many
**evenly spaced** lanes across the stretch the comb marks out.

Evenly spaced, because a comb cuts wells at one pitch — the lanes *are* uniform,
and the useful question is where the set starts and stops rather than where each
individual boundary falls. Cutting at the quietest column instead, which is what
this used to do, puts a boundary wherever the gel happens to be blank: an empty
lane and the margin either side of the gel end up counted as lanes, and the
loaded ones get squeezed into whatever is left.

Then each boundary is allowed to **slide onto the quietest column** near where
the grid put it, bounded to a third of the pitch, because a gel runs a little
wide or narrow and the grid alone is not quite it. Bounded, because unbounded —
which is what cutting at the quietest column used to be — a boundary walks off
into whatever blank stretch is nearest and takes its lane with it.

**Gels lean, and they fan.** On these scans the drift from top to bottom is 26 to
83 px, which at a lane pitch of about 100 px is most of a lane: a boundary placed
correctly at the top is halfway into its neighbor at the bottom, and a column
signal summed down the raw height has every gap smeared into the next with
nothing left to find. So the lean is measured — by sliding horizontal bands of
the gel against one another until their lanes line up — and everything measured
across the width is measured *along* the lanes instead.

The two sides do not lean by the same amount, so the lean is measured **at each
edge**. On these gels the two differ by up to 86 px — about a whole lane — which
no single shear can describe, and which shows up as boundaries that fit the bands
at one edge of the gel and miss them at the other. The lanes fan, and the block
is a different width at the bottom than at the top.

Each side is trusted only if it can be measured: half a gel with a band or two in
it gives a correlation that wanders and then a confident-looking slope through
nothing. The tell is the straight-line fit — a real lean puts every band on one
line to within a pixel or two, a lock onto the wrong lane misses by twenty. A
side that fails borrows the other's value, which says the gel leans without
claiming to know whether it fans; if neither can be read the lanes stay upright.

Three more ways a band of gel has nothing to say, all of which a blot produces
and a gel rarely does, and all of which were found on one field of four flat
membranes reading 42, 63 and 9 px of lean:

- **The match is flat.** Blank membrane matches the middle of the gel equally
  well however far it is slid, and the best of a flat curve is noise with a
  number on it. A band with lanes in it loses the match as soon as it moves, so
  the peak has to beat a typical slide by half before the band gets a vote.
- **The match is still improving where the search stops.** A best slide sitting
  on the edge of the window never had its peak found at all; the number is the
  width of the window, not the shift of the band. One of those was the whole of
  a 63 px lean.
- **The bands that voted do not span the gel.** A lean is a claim about the
  whole height and has to be fitted across it. Three bands out of the middle
  fifth, one of them a pixel off, extrapolate to 9 px of shear over the rest.

The boundaries then follow. They are stored at mid-height and drawn as
quadrilaterals, each edge with its own lean, so an excised lane takes its own
column with it rather than a vertical slice of itself and two of its neighbors.

The measurement is a starting point, not a verdict: **lean L / R** in the
inspector is the drift in source pixels from top to bottom at each edge, and you
can type either, or **shift-drag** any boundary on the canvas — the side you
grabbed nearer is the side that moves, and the further from mid-height you take
hold the more leverage you have. A shift-drag at mid-height has none, so it moves
the boundary instead. `upright` zeroes both, and `re-measure lean` goes back to reading it off the scan.

A lean you set survives a change of lane count: you corrected it once, and
re-counting the lanes is not a reason to throw that away.
Whatever angle is set is the angle the densitometry is measured along, and the
one the record reports. Setting a lean resamples nothing: the scan is left as it
is, and the lean is reported in `Integrity…` as a measurement of the gel rather
than something done to it.

**Turning the whole picture.** A lean shears the lanes without moving a pixel,
which is the right answer when the gel ran crooked inside a square scan. It is
the wrong answer when the gel was *laid down* crooked: then the bands, the
membrane's edges and the lanes are all off by one angle, and the figure wants
the picture turned. **angle °** in `crop, rotate, contrast` is that turn,
clockwise degrees on top of the quarter turns, and unlike a lean it does resample
— it is the one place in the program that does, and `Integrity…` says so in
those words. It is applied **in place**, at the same pixel count: the frame keeps
the crop's own width and height, which is the coordinate space every lane, rung,
label and box is recorded in, so the turn is one rotation in one frame rather than
a resize that every recorded position would have to be rescaled through. The
corners of the crop rotate out of frame, and the edge pixel is repeated into the
gap rather than black, which on a scan of dark bands would read as signal — so
turn first and crop after, or crop a little wide and trim.

**straighten** measures the angle instead of asking you for it, two ways, and
takes the first that answers:

- **By the two ladders.** Two sets of standards run at the two ends of a gel are
  the best straight edge on it: the same proteins, the same run, so the line
  through a size marked in *both* is level exactly when the gel is. Mark the
  rungs of each and type their sizes; every size that appears in two lanes far
  enough apart gives an angle, and the **median** of them decides, so one rung
  clicked on the wrong band does not. The note under the button says what it
  would turn by before you press it.
- **By the rows of bands.** Failing that, the bands themselves. A gel sitting
  crooked has its rows of bands crooked by the same angle, so the picture is
  averaged along lines at each candidate angle and the angle whose profile has
  the **sharpest** rows wins. Only the rows that every line crosses are scored,
  or a steeper angle would be rewarded for the rows it runs off the edge of.

This is the measurement the lean cannot make on a blot. The lean is read by
sliding horizontal bands of the picture against one another, which needs a
pattern down the whole height and votes from bands spanning it — a membrane with
three rows of bands on it has neither, and correctly reports no lean at all. The
bands are the other half of the same fact, and are there when the lean is not.

A turn is a change of picture, so the lanes are found again and what was read off
the old one is cleared — with one exception, because the exception is the point:
**the rungs turn with it.** A rung records which lane it was clicked in, and a
fine angle is a rigid turn of the same frame, so it can be carried onto the band
it was clicked on exactly. Without that, leveling by two ladders erased the very
rungs it was measured from. Nothing else recorded has a horizontal position to
turn it by — a band label and a measured box are a row in a lane, a strip is a
horizontal band of the whole picture, and after a turn none of those rows is
horizontal any more — so those are cleared, the hint says which, and one undo
puts them back. A rung from before rungs carried a lane has none either, and is
counted in the hint rather than silently left off its band. `square` puts
the angle back to nought.

The extent comes from the **comb** rather than from the bands, because the comb
is what defines the lanes. It is there whether or not a lane was loaded, and it
spans the whole set even when half the wells ran empty; band content cannot do
either — an empty lane looks like margin, and a gel whose samples all ran in the
middle looks narrower than it is. The outermost wells are lane centers, so the
block is widened by half a pitch at each end. A scan with no comb in it falls
back to an even split of the full width.

**The outermost boundaries set the block.** Drag the one at either end and every
boundary between re-spaces evenly, because the lanes are uniform — so two drags
put the row exactly where the wells are. This is the reliable way to get it
right: automatic detection of where the row of lanes *starts and stops* is the
one part of this that does not work well. Three signals were tried — fitting a
row of N wells to the comb, thresholding the comb strip, thresholding the band
content — and on real scans the comb is not cleanly periodic (autocorrelation
gives one weak peak), while the band signal is dominated by the ladder, which is
denser than everything else put together. The estimate is usually within half a
lane at each end, which is close enough to drag from and not close enough to
trust.

Drag an interior boundary to nudge just that one. Each lane carries a label, a
role and, when the backend is up, its share of the gel's total density.

Size marks go on the `left`, the `right`, or `both` — a wide gel is easier to
read against a scale at both ends than by tracking a band right across it.

**Size standards.** Mark a lane as **ladder** in the lane list and its rungs are
found for you — the profile down that lane, with the lane's own background taken
off, peaks where the bands are.

The background is a rolling **minimum**, not a rolling mean. A mean rides up over
the closely spaced rungs at the crowded end of a ladder and subtracts them away
along with the background, which is where bands went missing; a minimum follows
the gaps between them instead. On these four gels that is the difference between
eight rungs and twelve, and the ones it was losing were the informative upper
ones. Positions only: the sizes are the one thing the
scan cannot tell you, so they come off the tube, typed or filled from `sizes…`
top-down. Neither the wells nor the gel's bottom rim can be a band — nothing
migrates above the wells, and the rim is darker than any band in the gel and left
in would set the scale for everything else — so those strips are not looked at.

**Where the wells are is found, not assumed.** A fixed tenth off the top was a
guess, and it went wrong both ways: a crop that kept part of the stacking gel put
the comb *below* the guess, where it was counted as the topmost rung, and a crop
trimmed close to the wells put the first real rung *above* it, where it was
thrown away. So the comb is looked for. It is the first line down the picture
that spans the lanes — nothing migrated above it — and it is told apart from the
gel's own rim, the other line up there, by its teeth: a well line is broken at
every lane boundary where a rim runs unbroken from one side of the frame to the
other, so the comb darkens between 35 and 95% of the width and the rim more than
95%. Only the top fifth is searched, because further down a line spanning the
lanes is a band the samples share, and blanking to that would throw away real
rungs. When a comb was found and skipped the finder says so; a crop that already
starts below the wells has none to find, and falls back to the tenth.

It reports what it can see and does not make the count come out right: a ladder
that ran off the bottom has fewer bands than the tube says, and inventing the
missing ones would put a size where nothing was measured.

The r² of the fit is the check that matters, because a spurious rung shows up as
a point off the line. On all four of these gels ten found rungs fit log₁₀(MW)
against mobility at r² = 0.986 to 0.995.

Or do it by hand: `click bands`, then click each ladder band and type
its size. From two or more marks it fits log₁₀(MW) against relative mobility and
prints r². The fit is used to size annotated bands — but never past the ladder:
a band above the top rung reads `> 250 kDa`, not an extrapolated number. On a
gradient gel the r² will be poor, and the honest response is to read sizes off
the ladder instead.

**The printed scale.** The sizes go beside the panel — left, right or both, at
**mark pt** — each with a bar across from it. **bar mm** is how thick that bar is
drawn, 0.22 mm by default and up to 2 mm for a figure that will be shrunk to a
column width. A thicker bar is drawn longer with it, at the same 6:1 the default
pair has, because a bar as long as it is thick is a blob; the numbers step out of
its way rather than being written over it, and the room the scale takes grows
with them, so lining panels up and fitting the page both know about it.

**Cropping.** It is the first fold of the gel inspector because it is the first
thing to do: everything placed afterwards — lanes, rungs, boxes, strips — is held
in the crop's own pixels, so a crop decided last moves all of it. `crop…` shows
the whole scan with the part you are cutting away
dimmed, and you drag the outline: eight grips on the rectangle, or the inside of
it to move the window without resizing. The panel normally shows the *cropped*
render, which is exactly the thing you cannot crop by eye — you would be dragging
the edges of a picture whose surroundings are off screen — so while cropping it
shows the full frame instead, and puts the crop back when you leave. The full
frame of *whichever picture the panel is showing*: a blot set to its white light
stays on its white light, and so does one you are holding `h` on. Cropping is
exactly when the white light is wanted, because it is the picture that shows
where a membrane stops — switching to the signal the moment the outline appeared
left a tray of seven membranes to be cut out of a picture in which six of them
are blank. Enter or `done` keeps it; Escape puts back the crop you started with.
A whole cropping session is one step to undo, however many times you nudged an
edge.

**`find the gel`** detects the outline for you. Each side is judged on its own,
from the outside in, because a gel is not necessarily in the middle of its scan
and a threshold fitted to the whole image will happily put the boundary through
the ladder. The only thing it trusts is that a real margin's first few lines are
uniform; it walks inward from there until the picture stops looking like them.

Each side is judged by walking inward and stopping at the first place the line
profile **steps**, comparing each window against the one before it rather than
against the outermost line.

Three things then have to be true of that step before it counts as the edge of
the gel. It has to **stay**: an edge is a step that holds, while a band is a dip
that comes back, and without that test a strong row of bands reads as the top of
the gel and takes half the picture with it. What is being cut off has to look
properly **unlike** what is kept, judged over the whole strip — between two lanes
of a gel it does not, since the densest lane differs from its neighbor by a
twentieth of the range where a gel differs from the bed it lies on by a quarter,
and that is what stops a crop walking in and taking the ladder. And along the
height only, it goes on from the step to the gel's own **rim**: the first step is
where the background stops being background — the shadow lying beside the gel —
so stopping there leaves that shadow in the crop. Only along the height, because
across the width the nearest dark thing inward is not a rim, it is the ladder. Comparing against the edge is what used to leave a
strip of background along the bottom of every scan: a scanner bed shades gently
from one end to the other, and by halfway down that drift alone exceeds any
threshold small enough to catch a real edge, so the walk stopped on the shading
instead of on the gel. A gradient gives small steps between neighbors; the
gel's rim gives one large one.

A gel already trimmed flush on one or two sides therefore keeps those sides:
with no step to find, nothing is done and the side is left where it is rather
than guessed at. The reason for every side it did not move is printed.
The whole thing errs towards cropping too little — a margin of scanner bed is
untidy, a crop through the ladder is lost data — and whatever it finds is a
starting point you can then drag.

**Contrast.** Black point, white point and gamma, applied to the **whole panel
in one operation on the original data**, never to an already-leveled 8-bit
render. The histogram spans the data rather than the full 16-bit well, because a
Coomassie scan lives in the top fifth of one. γ ≠ 1 is flagged in the panel and
in the record as a non-linear adjustment, because that is what it is.

**Resolution.** The panel embeds the crop at the resolution it was scanned at.
Nothing on the way to the figure rescales it — a fine **angle °** turns it in
place, at the same pixel count, and is the one thing that touches the pixels at
all — so the dpi you get is the scan's own: crop pixels across, divided by the
millimeters the panel is drawn at. A
1200 px crop shown 30 mm wide is a little over 1000 dpi; the same crop shown
150 mm wide is 200, and no setting in this app can rescue that — only a better
scan can. What that costs is file size, which is visible: a gel-doc scan is a few
hundred kilobytes of the exported SVG, and a whole A4 flatbed sheet at 300 dpi
would be a few megabytes.

Everything else in the export stays vector with live text; only the scan is
raster, and it is embedded rather than linked, so the SVG stands alone.

The embedded PNGs are compressed at zlib level 3 rather than as small as they
will go. PNG is lossless at every level, so this costs about a fifth more bytes
in the exported SVG and nothing at all in the picture — and it is the difference
between a contrast change taking a tenth of a second and taking a second and a
half, which you pay on every one of them.

**Excising lanes.** The scissors on a lane row takes it out of the panel. The
lanes on either side are then not neighbors, so the panel draws a white gutter
and a rule on both sides of it. That marking is on by default and turning it off
is reported as a finding, not as a preference: journals require assembled lanes
to be delineated, and a bare gap is indistinguishable from layout.

The panel never stretches. Cutting three lanes out of a twelve-lane gel makes
the panel narrower; it does not squeeze the remaining nine to the old width,
because that would change the apparent mobility of every band in it. The height
is the handle and the width follows.

**Cutting a gel in two.** `∥` beside a lane cuts the panel there into two
panels, each showing the lanes on its own side and nothing else. That is the
difference between it and the scissors: an excision leaves the two lanes either
side of the gap side by side, which is a claim that needs marking, while the
parts of a cut are separate panels standing apart on the page — nothing is
juxtaposed, so there is no splice to mark, and the report says that rather than
saying nothing. The lane clicked on is the seam. A **ladder** or a **blank** one
goes to neither part, being there to separate them in the first place; any other
lane holds a sample, which would be lost, so it starts the second part instead.
Each part keeps the whole gel's lanes, ladder and window, so the two read against
the same scale at the same levels, and the second is left untitled, because two
panels captioned the same thing say they are the same panel — which is the one
claim the cut makes false. Both are named in the record: `Integrity…` marks each
as one part of a gel cut in two, and the caption draft says so in a sentence, so
they are not read as two gels. One undo puts the gel back together.

**Strips of one membrane.** If parts of a blot were cut apart and probed
separately, give each panel the same **membrane id** and a note saying which
part it was. Panels sharing an id are reported as strips of one membrane, cut
before probing — which is a different claim from one membrane reprobed, and a
different claim again from two crops of one scan. Panels that share a *source
file* are detected on their own and reported as regions of one image.

**Everything placed on a panel moves with its crop.** Lanes, rungs, labeled
bands, measured boxes and strips are all held in the crop's own pixels, so a
crop that starts forty rows lower would leave every one of them forty rows out —
silently, on a figure that still looks plausible. Re-cropping keeps each on the
part of the scan it was placed on instead, and rescales the lean, which is
pixels across a height that has just changed. A turn is a different picture — a
quarter of one has every lane running the other way — so the lanes are found
again, what was read off the old picture is cleared, and the hint says so; a fine
angle keeps the rungs, which it can turn onto their bands exactly. One undo puts
it back.

## Western blots

**Two pictures of one membrane.** An imager takes a western as a pair: the
chemiluminescence, which is the measurement, and a white-light picture of the
same membrane in the same frame, which is the only place the prestained ladder
shows — a colored marker is not luminescent, so in the signal its lane is
blank. `Blot` (`w`) makes a panel that holds both: `load signal…`, then
`load white light…`.

Drop the two files together and they are paired by name —
`blot2_Chemiluminescence.tif` with `blot2_Colorimetric.tif`: *white*,
*colorimetric*, *marker*, *epi-white* or *bright field* on one side, *chemi*,
*lumi*, *ECL* or *signal* on the other, matched as whole words so that a lab
called Whitehead is not a white-light image, and *membrane* or *mem* counts too,
since that is what an imager calls the half of the acquisition that is not the
exposure. A white-light file dropped on a blot that already has its signal goes
beside it rather than replacing it.

Two files and one of them a white light is paired whatever they are called. An
imager names the two halves of one acquisition nothing alike — a serial number
for the exposure and `mem.Tif` for the membrane — so there is nothing to match
on, and with exactly two pictures in hand nothing that needs matching.

**Several membranes in one field of view**, which is how anybody who owns an
imager uses it, are found in the white light and each gets its own panel,
cropped to itself. A membrane is a rectangle on a dark tray; the signal picture
is mostly empty and says nothing about where a membrane stops, so the pieces are
read off the white light and the crops fit both pictures, which are one frame.

**Cuts are found inside them.** A strip cut off a blot and probed on its own is
laid back down against its neighbor, and what shows between them is a thin dark
line. A fold, or the shading where a membrane curls at its own edge, is dark too
and *darker* — on the blot this was written against, the strongest dark line in
the upper membrane was a fold five times deeper than the cut beside it. So the
test is width, not depth: a cut is already as dark against the membrane four
pixels away as against the membrane fourteen pixels away, and a shadow is not,
because at four pixels it is still inside itself. Slopes are searched as well,
because nobody lays a membrane down square and a line one degree off runs across
thirteen rows of a picture this size — averaged straight down the columns it
flattens into the membrane and is not there at all.

**One membrane is one connected piece of the picture.** Not a band of dark rows
crossing the whole frame and then a band of dark columns inside it, which is how
they used to be found: that needs the gaps between membranes to line up into
full-width and full-height lanes of tray, and nobody lays membranes out like
that. On a tray of seven laid where they fit, there was no such gap anywhere —
the whole field came back as one rectangle, cut into quarters, offered as four
panels that were each part of three membranes.

**And the threshold is two thresholds.** Membranes in one field are not equally
bright: on that same tray the dimmest read a quarter of the brightest, and one
threshold taken as a share of the picture's range left it out altogether. So the
mask is seeded on what is certainly membrane and grown down to what is certainly
not tray, which is what hysteresis is for — and a membrane lit across a fivefold
gradient comes back whole rather than as its bright end.

Each panel then records which of its four sides was a cut rather than the
membrane's own edge, and strips off one sheet are given a shared membrane id, so
the caption says they were cut before probing rather than reprobed. Pieces
thinner than a sixteenth of the membrane are not offered: nobody probes a
two-millimeter strip, and that is what the membrane's own bottom edge would
otherwise be taken for. The panels come out at **one scale** — drawn to a common
height instead, a short strip and a tall one would come out the same size, which
says the two pieces of membrane were the same and the lanes on them were too.

**A cut piece has lanes across the whole of it.** The lane grid is normally
fitted to the comb, which is right: the comb cuts the lanes, it is evenly spaced
by construction, and it spans the full set whether or not they were loaded. A
strip has no comb — it was cut off below the wells — and read for one anyway, the
topmost row of bands answered instead. The grid was then trimmed to the lanes
that happened to run on that strip, at a pitch to match, so one strip of a sheet
started thirty-five pixels in and its neighbor did not, and neither reached its
edges. A panel that says it was cut, or that carries a white light, is told so,
and the crop is taken as the gel: its edges were found in the white light and
they are where the lanes end. The two strips of one sheet then come out the same
width, as they must, being one sheet.

Across the whole of it is not the same as edge to edge. Ten lanes laid flush from
one edge of a crop to the other are ten lanes *plus* the blank strip down each
side, so the ten come out too wide and the outermost two sit half on background:
ten lanes of gel had become eight lanes and some margin. **side margin** is that
strip, measured in lanes — a lane's width is the only unit on a gel that means
anything — and it is counted at both ends, so `n` lanes with a margin of `m`
divide the crop into `n + 2m` and the first lane center sits half a pitch in from
the margin. Half a lane each side is the default, which is about what a cut strip
has; `0` puts them flush against the edges again, and a wider one narrows the
lanes rather than shifting the block, which is the point — they stay uniform and
centered, because they were cut by a comb.

The lanes of the whole field are not one membrane's lanes, either. The first
panel of a split is the one the files were dropped on and already had ten of them
spread across all four sheets; kept and fitted to a single sheet's crop, seven
folded onto its edges two pixels wide. They are cleared, and found again on the
piece.

The two have to be one frame. The same size is the usual case; a signal taken
at 2×2 binning is half the size of its white light and is matched by scale — the
crop, the lanes and the lean are carried across by the factor. A pair that is
not the same shape at any scale is refused with both sizes printed, because the
size standards would then be read off one picture and drawn against another.

**Size standards from the white light.** With a white light loaded,
`find the rungs` reads the ladder lane in the white-light image, and
`click bands` on the ladder shows the white light while you click; the panel
goes back to the signal when you press Esc. Which picture the rungs came from
goes into the record. The scale is then drawn beside the signal as for any gel.
A membrane split out of a field of view has this done as it is made: the white
light is the picture in hand at that moment, and it is the only one the ladder
is in.

**Which lane the ladder is in is read off the picture too.** Nothing in a
blot's signal says where a lane of it is — there is one band per lane, if that —
so a lane count spread across the membrane is a guess, and on a cut strip it is
a guess that lands half on the ladder. But the white light of a western shows
the prestained ladder and nothing else, the samples being colorless until they
are probed, so the lane with the most ladder in it is the ladder. Every window
across the membrane is read for rungs and the best one wins, which is the
detector run sideways rather than a second idea of what a band looks like.

Two things about that search had to be true before it worked. Windows are
compared on how *dark* their rungs are and not on how many they have: blank
membrane has a noise floor of nothing, so everything in it clears a threshold
set from its own noise, and an empty lane out-counted a ladder eleven to four.
And the profile down a window is its **median** across the lane, not its mean —
a rung is a bar that spans the lane, while a pen mark beside lane 1, a sliver of
the neighboring lane and a corner of imager tray inside the crop are each dark
over part of it. On a mean, a window half on the ladder and half on somebody's
handwriting scored higher than the ladder itself.

**Three length scales that were shares of the picture and are now band widths.**
A band is the same few pixels across whether the picture is a whole blot or a
strip cut off one, and every one of these read as a fraction of the height
collapsed on a 200-row strip and took the ladder with it:

- the rolling-minimum baseline, at a twentieth of the height, became narrower
  than the rungs and stepped *into* them — subtracting each band away with the
  background it was supposed to be sitting on;
- the test that tells a band from the membrane's edge looked 2.5% of the height
  either side, which is five pixels, which is still inside the band, so every
  rung failed it and the lane came back empty;
- the minimum spacing between two rungs, at 2% of the height, was four pixels,
  which split broad rungs in two. Two maxima with no valley between them are one
  band with a dent in it, and a dip is a length scale the picture supplies.

A rung nearer the membrane's edge than its own width is not offered at all.
There is nothing on one side of it to compare it with, and the edge of one of
these crops is the imager tray, which is darker than any rung on the blot.

A white-light picture is dark bands on a light membrane by physics — a
prestained band absorbs the light — so that is what it is taken to be, rather
than what its histogram suggests. The histogram's guess, that the commonest
value is the background, is wrong here in the usual case: the commonest value
is the dark imager tray around the membrane, and read that way every rung comes
out as the two light edges either side of it. `invert` is there for an export
that came out the other way round.

A membrane has no wells and no rim, so its ladder is read differently from a
gel's. The top tenth is not blanked, since a membrane's first rung can sit a
few per cent from its edge; instead a rung has to fall away on *both* sides,
because the edge of the membrane, where it meets the tray, is a step that stays
— and against a rolling-minimum baseline a step looks exactly like one more
rung. On the three example blots this finds ten rungs of ten, each within half
a pixel of where it was drawn.

**What the panel shows.** `show` picks the signal, the white light, both
multiplied, or **the signal with the ladder lane in white light**. Multiplying
puts the prestained ladder where it really ran beside the bands, but it does it to
every lane, so every measured band has the membrane's own mottle through it. The
fourth choice does not: the lanes marked `ladder` are the only part taken from the
white light, and the rest of the panel is the chemiluminescence alone,
unmultiplied. The white-light lane is cut to the lane's own quadrilateral, lean
and all, and clipped to the segment it belongs to, so a split panel does not
borrow the other piece's ladder. It usually wants its own black and white — a
membrane reads mid-gray where a chemi background reads white — and those are the
same controls in the same fold.

Either composite is made on the signal's grid — the white light is resampled to
it, never the signal to the white light — and both are declared in `Integrity…`
and in the legend draft, because a panel made of two pictures has to say so. The
ladder-lane one names the lanes it took.

**Hiding the luminescence.** The white light is the layer under the signal —
the same membrane, the same frame — so hiding the signal is what shows it. The
toolbar's **white light** tick does that on every blot at once, and holding `h`
does it for as long as it is held. Neither touches `show`, because looking at
the membrane is not an edit of the figure: nothing is recorded on the panel, and
an export puts the signal back first, since an export is a copy of the canvas
and the canvas has to be the figure when it is taken.

**Only some sizes.** `slice by size…` takes ranges in kDa — `100-50, 45-30` —
and shows each as its own strip, one above the other, with the ladder ticks that
fall inside it and a label beside it: the antibody, filled in from the rows
measured inside the strip when there are any. Sizes are read off the ladder rung
by rung, straight in log(size) between the two rungs either side, which follows
a gradient gel where one line through every rung does not; a size outside the
ladder is refused rather than extrapolated, and `top` and `bottom` reach the
ends of the gel. Either edge of a strip can then be typed, or dragged on the
canvas.

Every strip is at the gel's own scale, so the height handle sizes them all
together and each is exactly as tall as its share of the membrane. They are cut
from one image with one window: a loading control far brighter than its target
is shown from a shorter exposure, which is a second panel, not a second window
on this one. A strip with no ladder rung inside it is a finding, because nothing
on the figure then says what size it shows. The rest of the membrane is in the
source data, with the strips outlined on it.

## The supplementary sheet

A journal wants the uncropped blot, and the honest version of that is not the
raw scan: it is the *same* picture the figure shows, with the cropping taken
off. **`figure`** in the toolbar builds it the first time it is clicked and
switches between the two sheets afterwards.

Every cropped gel or blot panel in the figure gets a twin on the sheet, in the
figure's own order and carrying its letter — `(C) blot 1`. The twin is the panel
widened to its whole membrane and nothing else changed: the same orientation,
the same fine angle, the same black/white/gamma, the same lean, the same lanes
and their labels, the same ladder rungs. Lanes cut out of the figure are back,
strips are gone, and a panel with a white-light scan behind it is shown as
`ladder`, so the size marker lanes read as the film never showed them.

The whole membrane, not the whole picture. One imager field holds the whole
tray, and eight blots each shown with the other seven lying beside it is not
what an uncropped blot means. The pieces come from the same finder `split
membranes` uses, asked of the same white light, and the one the crop's middle
lies on is the one shown — grown to take in a neighbor if the crop reaches over
a cut line, because showing three quarters of what the figure used is worse than
showing two strips. A picture with no white light, or one where nothing stands
out from the tray, falls back to the whole frame and the sheet says how many did.

The region the figure uses is outlined in red. It is the crop's four corners put
back through the panel's own geometry, so on a panel that was straightened it is
a turned quadrilateral, not a rectangle drawn near where the crop was. A panel
whose crop was already its whole membrane — cut down by its lanes or its strips
instead — gets no outline, since it would only retrace the panel's own border.

A membrane is wider than the piece of it the figure showed, so its lanes sit
closer together: a lane label wider than its own lane is slanted rather than
printed over its neighbors, and the panel's title goes above whatever the
labels actually reach, a slanted row included. In the crop fold,
**`show … the whole picture`** and **`region used … outline it`** are the two
switches by hand, on any panel.

The sheet is a canvas like any other — move, resize, relabel, add text, export.
Exports are named for the sheet showing: `figure.svg` and `supplementary.svg`,
`figure_600dpi.png` and `supplementary_600dpi.png`. **`rebuild from the figure`**
replaces the sheet with a fresh build, which loses anything arranged by hand;
one undo brings it back. Undo crosses between the sheets, and a session carries
both.

## Quantifying bands

**Clicking a band.** Under `quantify bands`, add a row for the protein being
measured (`+ target`) and one for what it is divided by (`+ loading control`),
then `click bands` on a row and click that band in each lane. A click is moved
onto the band nearest it — the highest point of the lane's profile within a few
per cent of the gel's height, off the lane's own rolling-minimum baseline.
**Shift-click** measures the band in every lane at once; `every lane` fills in
the lanes a row does not have yet and leaves alone the ones you placed.

**One box size per row.** The first band clicked sets the box: as tall as that
band, out to where it falls to a tenth of its peak, and as wide as the lane less
10% at each side. Every other lane in the row gets a box of the same height.
That is what densitometry software recommends, and the reason is measurable: on
the example blots, boxes each fitted to their own band put two lanes 2–3% away
from the right answer, where one shared box put every lane within half a
percent. A click that finds no band does not set the size; it is measured where
you clicked, flagged, and the first band that can actually be seen sets it.

**What is measured.** The integrated signal in the box less its background, on
the original data: the counts as recorded for a light-on-dark image, inverted
against full scale for a dark-on-light one. The display window, γ and invert do
not enter it — making a faint band visible for the figure cannot change how much
of it there is. The box is sheared along the lane's lean exactly as the
boundaries are drawn.

Background is taken one of two ways, both local to the lane:

- **border**, the default: the median of a 3-px strip just above and just below
  the box, in its own lane. Above and below rather than all round, because
  beside a lane is the gap to the next one, which is a different background.
- **profile**: a rolling minimum down the lane, taken row by row under the box —
  better on a smear, where the strip just above a band is still smear.

Nothing is clipped at zero. An empty box measures as roughly nothing, sometimes
a little below, and that is the honest answer.

**Purity: the whole lane.** `whole lanes` measures every lane that holds a
sample floor to ceiling, as one box — the same picture, the same background
rule, the same inset at the lane's sides, and nothing differing but the height.
The target band over that is the **purity**, and it appears in the per-lane
table, in `Integrity…`, and in a purification table whose step is named the way
the lane is labeled. Nothing inside the lane is skipped: the well, the dye front
and everything smeared between them are all stain in that lane, and a purity
that quietly left some of them out would be a better-looking number nobody could
check.

What it is not is a mass purity, and that caveat travels with the number
wherever it is printed. It is a fraction of the **stain**: dye per milligram
differs between proteins, what does not stain is not in it, and what ran off the
bottom of the gel is not either. `no whole lanes` takes the boxes away again,
and the purity with them.

**Saturation.** A box with saturated pixels in it is marked `sat`, and its band
is left out of the quantification unless you say otherwise: the detector ran
out, the band held more than it recorded, and a ratio built on it is wrong by an
amount nobody can know. Saturated means at the file's full scale — or at a
plateau, because a camera that clips short of full scale shows up as many pixels
sharing the image's maximum exactly, which continuous 16-bit data does not do.
On the example blot with an overloaded loading control, that lane's ratio comes
out 3–4% high, and it is the lane left out.

**Replicates.** `quantify replicates…` on a blot makes a **Quantification**
panel for it (`q` makes an empty one), and `load replicate…` brings in the
others: pick the files, the signal and white light of each are paired by name,
and each blot arrives on the pasteboard beside the page with the first blot's
lanes, labels and rows already set. Drag its outer lane boundaries into place and
click its bands; the panel follows as you go.

**A blot joins a graph by being dragged onto it.** Hold it over the graph and the
graph lights up; let go and the blot is replicate *n* of it — and goes back
exactly where it was, because the gesture said "this belongs there", not "put it
there", and a blot left lying on a graph covers the thing it was just added to.
One undo takes back both. It reads as what is being said, and it beats finding
the graph, opening a fold and picking the blot out of a menu by name; the menu is
still there for a blot that is nowhere near it. Since a gel is covered edge to
edge by its own grips, the way to take hold of one anywhere is **ctrl-drag**,
which moves the panel and nothing else.

**And the graph is put where it does not cover the blot.** Right of it, else
left, else under, else over, else anywhere on the page it fits — measured on ink
boxes, because a graph's tick and axis labels hang outside its plotting frame and
are most of what collides. Never the pasteboard, since a panel there is left out
of the export. If the page is genuinely full it says so instead of quietly
landing on something.

**How much, or how far.** `measure` picks what is compared across the lanes:
**signal**, which is everything below, or **apparent size in kDa**. A shift is a
result in its own right — a cleaved, degraded or differently glycosylated protein
is the same protein at another apparent size — and it is read off the same boxes
that were clicked for densitometry, so nothing has to be measured twice. The size
is read off each blot's own ladder at the row the band was found on, straight in
log(size) between the two rungs either side: per lane, because the box height is
shared across a row so the lanes stay comparable but where each box sits is its
own band's. Past the ends of the ladder there is no size and none is invented.

Nothing divides it and nothing is set to 1 — kilodaltons over kilodaltons is not
a quantity — so the loading control and `relative to` are not offered. Neither is
`saturated`: a clipped band is the wrong height but not in the wrong place, so it
still has a position when it no longer has an amount. The axis does not start at
zero, because the floor of an amount is zero and the floor of a size is the
smallest size measured; and the panel switches to points with a rule at the mean,
because a bar drawn from an axis that starts at 30 is a bar about nothing.

**Normalization.** Each lane's target is divided by the loading control in the
same lane, which takes out how much was loaded. Each blot is then expressed
relative to one of its own conditions — `relative to`, the first by default —
which takes out how long it was exposed: ratios from different blots are not on
one scale until that is done, and a mean across them is not a mean of one
quantity. Conditions are matched across blots by lane label, or by position. The
reference condition is then 1 with no spread by construction, which the inspector
says rather than leaving it to look like a remarkably reproducible control.

**Two lanes of one condition on one blot** — the same label twice — are two
preparations run side by side, or one preparation loaded twice. The first counts
towards n; the second is a second reading of one thing and belongs in one point.
Nothing in the picture tells them apart, so `repeated lanes` asks, and appears
only on a quantification that has some. They are replicates by default, which is
the commoner reason to load a condition twice. Either way the blot is normalized
by their **mean**: a blot divides by one number however many times the reference
was loaded, or how often you loaded the control would move every other bar.

What this does not buy is independence. Two lanes of one blot share a membrane, a
transfer and an exposure, so n counted that way is not n independent replicates
— the inspector and `Integrity…` both say so when n is larger than the number of
blots.

**What is drawn.** The mean per condition as a bar, one point per blot — or per
lane, where a condition was loaded more than once and the lanes are counted
separately, drawn apart rather than one on top of the other — and error
bars as SD or SEM; the axis starts at zero (except for a size) and ends on a tick. `numbers…` gives
everything behind it as CSV — each band on each blot, the ratios, the relative
values, and what was left out and why — and the source-data sheet carries the
same table, every replicate blot uncropped with its measured boxes drawn on it,
and the white-light images the sizes were read from. The legend draft states the
normalization, the n, and any lane left out.

The quantification holds no numbers of its own. It names the blots and the rows
to read, and draws what the boxes on those blots measure, so correcting a box on
a replicate corrects the bar it feeds.

## The table fills itself in

A purification table is the one panel whose numbers can be typed, which is why
it was the one panel that could disagree with the figure around it. **from the
figure** takes back the ones that are already known.

Name a step the way the sample is named in the A₂₈₀ panel — `StrepTrap HP` for
`StrepTrap HP` — and that step's **volume** and **total protein** come from
there, through the same extinction coefficient the A₂₈₀ panel prints on itself.
Matching is by name rather than by a link, the way a quantification pairs lanes
across blots, so re-reading the spectrophotometer file after a correction keeps
every row where it was. A sample measured twice is a disagreement rather than a
correction, so the first reading stands and the second is left for you to
settle.

**Target** is then total × purity, and **yield** is each step's target against
the first step's. Those are the two columns a reviewer recomputes, and they are
the two a typed table gets wrong: not when they are entered, but when the mg
column changes afterwards and nobody goes back. Here they cannot be stale,
because they are not stored — turning **from the figure** off brings every typed
number straight back, unchanged, because nothing was ever written over it.

**Purity** comes off a gel whose whole lanes have been measured — `whole lanes`
under `quantify bands`, where the step's name is the lane's label — as the target
band over everything in that lane. One gel: two gels measuring one step is a
question about which of them, and a table is not the place to answer it. Without
that measurement purity stays as typed, and the arithmetic follows either way.

`Integrity…` prints the table row by row, naming every cell that came from the
figure and where from, so a reader can tell a derived number from a typed one
without taking either on trust.

## Chromatograms

Every panel takes a **title**, and a loaded run takes the file's name unless you
have already given it one — which run a trace is, is the first thing anyone asks
of a figure with more than one on it, and the file already knows. Titles sit
clear of whatever else is above the plot: the fraction bar, then the standards
ticks, then the title.

**Dropping a file anywhere in the window** loads it and makes the panel for you —
over the canvas, the inspector, the toolbar, the margins. A drop the page does
not take is a drop the browser takes instead, by navigating away to the file,
which loses the figure and looks exactly like nothing happening. Drop onto an
existing panel and the file loads into that one rather than making another.

`load run…` on a chromatogram panel opens the server's file dialog, and falls
back to the OS picker when the server is down — the browser reads every one of
these formats anyway, so there is no reason to offer a file browser that can only
say "offline". Either way the shape
is **detected, not assumed** — by content, not by extension, because all three
of these formats get saved under all three suffixes.

**A UNICORN `.RES`** is the file the instrument writes, and reading it directly
skips the export step. It is binary: a header, a directory of 344-byte entries,
then one block per curve or event list. Every curve comes across — UV,
conductivity, pH, pressure, temperature, %B — with the fraction table, the
injection and the run log, at full sampling. UV and conductivity are turned on;
the rest are loaded but left off, because a disconnected pH probe reading a flat
14.5 belongs in the record rather than on the figure.

Each curve stores one integer per point and *two* candidate x axes, accumulated
time and accumulated volume, without saying which the integer counts. The event
lists settle it: every mark carries its time and its volume, so the right axis
is the one under which the trace still reaches the last mark. Reading a 70 min
run as 29 min leaves the final logbook entry off the end, which is the tell.
With no marks to check against the millilitre axis wins, because a
size-exclusion column is read in volume.

**A UNICORN ASCII export** is UTF-16 with a BOM, tab separated, and one *pair* of
columns per curve — each pair carrying its own volume axis, because the curves
are not sampled together and a 27 000-point UV trace shares a file with a 36-row
fraction list. Anything that assumes a single shared x column mangles this
quietly. It arrives under `.asc`, `.txt` or `.csv` indifferently, which is why
nothing here decides by extension.

The header is **two or three rows** depending on where it was exported from, so
the names and units are read from the *bottom*: units last, curve names above
them, the run name (`Chrom.1`) above that if it is there at all. Counting from
the top instead labels every curve in a three-row export `Chrom.1`.

Fraction, injection and run-log columns are recognized **by name**, not by
whether their values parse as numbers: a fraction column labeled `1, 2, 3`
otherwise loads as a perfectly good curve and lands on the plot as a staircase.
They are kept apart, too — only the fraction column reaches the fraction bar,
because merging them files `Sample Application` between tubes 3 and 4.

The paired layout is detected by every even column being a volume that only goes
up. A fraction or injection pair holds a handful of rows against the curves' tens
of thousands, so a column with too few numbers **abstains** rather than voting
the layout down, and the units row corroborates: in a paired export every even
column carries the same volume unit.

**A plain `x, y1, y2…` CSV** works too, with or without a header row.

Reading happens in the browser as well as in the backend — same detection, same
result, same field names — so drag and drop works with the server down. The
backend path is there for the file dialog and for very large files.

**Which zero the axis has.** A UNICORN run counts volume from the start of the
method, which is not always the injection: prime for a millilitre first and every
peak sits a millilitre further right than the volume the column saw. V₀, Vt and
every standards kit are column volumes measured from the injection. Reading one
against the other puts every Kav — and so every mass — out by the injection
volume, silently, in the direction of *bigger*. So the injection is read out of
the file — a `.RES` and an export both carry it — and when it is far enough along
the run to move a Kav it is drawn as a marker, `x from inject` re-bases the panel
onto the column's frame in one click, and leaving the two frames mixed is a
finding in `Integrity…` rather than a preference. A method that starts at the
injection records it at ≈0; that is said in the record and otherwise left alone,
because marking a zero is clutter and warning about a frame that is already right
is worse than clutter.

The wavelength is not invented either. An ÄKTAprime records the trace as plain
`UV` — the wavelength is set by the filter in the monitor, not by the software,
so it is not in the file — and that curve is labeled `Absorbance (mAU)`. A file
that does name a wavelength gets `A₂₈₀`.

**The window the traces are drawn in** is whatever they cover, padded a little.
Untick **auto range** under *axes* and x, y and — where a curve is on the second
axis — y2 become yours: a SEC profile cropped to the peaks, or two columns drawn
to one scale so the shift between them is the thing you see. Anything outside
the window is clipped, not rescaled.

Which axis a curve is drawn against is a question about its **unit**, not its
name. `UV_CUT_TEMP@100,BASEM` is the baseline UNICORN subtracted, in mAU, and it
belongs beside the absorbance it came off — the word `TEMP` in the middle of it
notwithstanding.

Set the column and V₀/Vt from the presets, load a standards kit, and type the
elution volume beside each standard: the panel then draws the standards as ticks
along the top and reports log₁₀(MW) against Kav with an r². Peak labels can
carry the volume, the calibrated mass and the A₂₆₀/A₂₈₀ ratio.

**The columns.** Picking one brings its published characteristics with it — bed
dimensions, column volume, the range of masses the resin separates, its exclusion
limit, recommended and maximum flow, plate count, sample volume, product code —
and they reach `Integrity…` with the figure. Each entry says where it came from,
because the difference matters once a number is in a paper: the Superdex 200
Increase family is transcribed from Cytiva's data file 16542, while the Superose 6,
Superdex 75, Superdex 30 and prep-grade entries carry family characteristics with
no data file cited, and are worth checking against your own column's papers.
Where no figure is published — plate counts and pressures outside that data file —
the field is left empty rather than filled with a plausible one.

A calibration then gets read against the column as well as against the standards.
Outside the standards the fit has nothing to say and no mass is quoted at all;
*inside* the standards but outside what the resin separates, the arithmetic still
produces a number, and it is that number — plausible, and wrong — that ends up in
a legend. So a mass past the exclusion limit is reported as the void it is, and
one outside the fractionation range is flagged.

**Where the construct says the peak should be.** A `construct` panel already
knows what its protein weighs, and what the pieces weigh after the protease.
Point the chromatogram at one with **expected from** and each of those masses is
put back through the calibration — the same fit, read the other way — and drawn
as a dashed blue line at the volume it predicts, labeled with the species and
its mass: the whole construct first, then each cleaved piece.

They are dashed, and in a color of their own, because they are a **prediction
and not a measurement**. That is the use of them: the line is where a globular
protein of that mass would elute, and what the figure shows is the distance
between it and where the peak actually is. A dimer comes off early and the line
says by how much.

Only from a real calibration, and only inside the standards — below the smallest
or above the largest the fit is extrapolation, and nothing is drawn, which is
usually the fate of a cleaved tag. The rough scale never feeds it: a dashed line
saying "the monomer is here" is a peak label, and a ±2× ruler has no business
drawing one.

**A rough scale, when no standards were run.** `rough scale` draws a dim mass
ruler across the plot from the column's specification alone: the resin's
published fractionation range read as a straight line in log(Mr) against Kav,
the top of the range at Kav 0 and the bottom at Kav 1. Against real standards on
a Superdex 200 Increase 10/300 it lands within 1.7× across the range, so ±2× is
the claim — enough to tell a monomer from an aggregate, not enough to print.

It is deliberately faint, and it is *labeled on the figure* as well as being
faint, because dimness does not survive a photocopier and says nothing at all to
someone reading the caption. It stays off peak labels entirely: reading a mass
off a coarse scale shows you how coarse it is, while printing "90 kDa" beside a
peak does not. Turning it on is a finding in `Integrity…` and a sentence in the
caption draft; leaving it on next to a real calibration is a second finding,
because a reader then cannot tell which of the two a mass came from.

**V₀ is not one of the published numbers.** It is not a constant: it depends on
how the bed settled and it drifts as the column ages, which is why every column
ships with a certificate giving its own. What the presets carry is ⅓ of the bed
volume, which is where these beds usually land, and it is marked as an estimate
everywhere it appears — including as a finding in `Integrity…` — until you replace
it with the volume you measured with blue dextran. Kav is a ratio of differences
from V₀, so an assumed V₀ moves every mass on the panel. Typing your own value is
what turns the record from *assumed* to *measured*.

The panel also checks the column against how it was run: a Vt that does not match
the bed volume, a V₀ at or above Vt (which makes Kav uncomputable), and a flow
rate above the column's maximum.

Shade the pooled range and the fraction bar shades with it; run a brace from
there down to the gel and the two panels are tied together.

**Which fractions actually ran.** Mark gel lanes as **SEC fraction** and number
them — the lane's own label *is* its fraction, one field rather than two, and it
is what the brace ties to and what prints under the lane — then brace the trace
to that gel: each fraction it holds is shaded under
the curve over its own volume — from its own mark to the next — and the bracket
spans only those lanes, not the ladder and load lanes beside them. A bracket
wider than the lanes it points at is a wider claim than the truth.

Fractions 12, 13, 15, 16, 17 shade as four blocks with a hole where 14 would be,
because 14 is not on the gel. A gap in what was loaded is a fact about the
experiment rather than a rendering inconvenience, so it is drawn, and the missing
numbers are named in `Integrity…` and in the caption draft.

Nothing is stored twice: the gel names the fractions and the trace reads them, so
the two panels cannot come to disagree about which is which.

The bracket's ends are worked out from what each panel actually draws, not from a
fixed offset: below the trace it clears the tick numbers and the axis title, above
the gel it clears the lane labels and the panel title, asking the labels how tall
they are rather than assuming one line. Its crossbar is yours to place — drag the
bar itself, or set **crossbar** in the inspector between 0 and 1 — because how
much room there is between two panels is a layout question and halfway is only a
starting guess.

The fraction bar is drawn as a scale to read the trace against, not as a second
figure competing with it: small gray tube numbers on a gray rule, so a number is
there when you look for it and out of the way when you are not. It sits **above**
the trace by default, against the peaks the tubes were cut from and where the eye
is already looking, leaving the bottom to the volume axis; `bottom` puts it back
under the axis. Standards ticks stack clear of it either way. How many are
numbered follows from how many *fit* — the spacing is computed from the panel
width and the run's own tube count, and any one label that would still collide
with its neighbor is dropped rather than allowed to overlap, which is what
happens to the `Waste` a collector writes at the end. `label every`, the point
size and the color are all adjustable if a journal wants otherwise.

An elution volume is not a mass. The calibration says what the column was
actually asked, and a globular-standard curve is a guide for globular proteins —
put a membrane protein in detergent through it and the number is a shape
measurement wearing a mass unit.

## Concentration from A₂₈₀

**`A₂₈₀`** (`d`) is a table of readings and what they mean. Import a NanoDrop,
Lunatic or DeNovix export, paste one, or type readings in; only the absorbance
and the dilution are ever entered, and mg/mL, µM and total mg are derived at
draw time from the constant printed on the panel. Nothing derived is stored, so
correcting a dilution corrects the concentration, and the two cannot disagree.

**Paste a sequence** and the constants follow from it: mass from average residue
masses, ε₂₈₀ as 5500·Trp + 1490·Tyr + 125·cystine, A 0.1% as ε/M, pI by
bisection over the Bjellqvist pKa set, plus the composition, aliphatic index,
GRAVY and instability index. These are ProtParam's numbers, computed here rather
than fetched from ExPASy — a figure should not depend on a web form being up,
and the arithmetic is published. They were checked residue for residue against
Biopython's `ProteinAnalysis`, which runs the same calculation; where the two
mass tables differ slightly, this one follows ExPASy's, so a mass printed here
matches what ProtParam prints. FASTA headers, numbering, whitespace and case all
come off; anything left that is not one of the twenty is reported rather than
dropped. Not computed: half-life, which is a lookup by N-terminal residue and
organism, and the secondary-structure fractions.

If the sequence is not to hand, type the mass and ε — or A 0.1% directly. A typed
value wins, because someone who measured their own coefficient knows something
the sequence does not.

**Why this panel exists.** A NanoDrop left on "1 Abs = 1 mg/mL" reports a
concentration wrong by the ratio between that and the real A 0.1% — for the
nanobody in the example, by a factor of 2.25, in the direction of *more protein
than you have*. The reading itself never says so. So the imported file's own
concentration column is kept, compared against what the coefficient gives, and a
disagreement of more than 5% is a finding in `Integrity…` rather than a
discrepancy nobody looks at. A sequence with no Trp or Tyr is flagged too: that
protein cannot be measured at 280 nm at all.

A pasted nucleotide sequence is caught by composition. A, C, G and T are all
amino acids, so DNA does not fail to parse — it yields a plausible mass for a
protein that does not exist, which is the worst way for an input to be wrong.

## Constructs

The panel that says what was put in the cells: `construct` (`s`) is a bar of
segments — a tag, a linker, a protease site, the protein, a truncation — laid
end to end and **drawn to scale in residues**. That scale is the point. A
decahistidine tag is a fortieth of a 400-residue domain, and a cartoon
assembled out of boxes draws it as a third, which is the proportion a reader
half-remembers afterwards.

**Its reason to be a panel rather than a drawing is the mass.** A segment
carries its sequence where there is one, so the panel states what the band on
the gel beside it should weigh, and — where a protease cuts — what it should
weigh afterwards. `add` offers the tags whose sequence is settled (His₆, His₁₀,
Strep-II, FLAG, a GS linker, and TEV, 3C and thrombin sites), and those masses
are counted rather than estimated.

The fusion partners in that menu — MBP, GST, GFP, SUMO — carry a residue count
and no sequence, because each comes in variants differing by a linker or a few
residues and printing one version's exact mass against another's construct
would be worse than saying "about". A segment with a length and no sequence is
weighed at 110 Da per residue, and every number that estimate reaches is
written with a `~` rather than printed as though it had been counted. The
`seq` button on the segment replaces the estimate with the real thing.

**Reading it off the plasmid map.** `read a map…` takes a GenBank (`.gb`,
`.gbk`, `.ape`), a SnapGene `.dna`, a CLC `.clc` or a plain FASTA, and builds the
panel from it: it finds
the promoters, takes the ORF the chosen one drives, and cuts that ORF into
segments along the features the map draws inside it. Feature names become segment
names, the stretches between them stay unnamed, and every residue of the ORF
lands in exactly one segment — the panel is the sequence, not a summary of it.
It runs on the server and needs Biopython (`pip install -r requirements.txt`).

**Which promoter** is a menu, and the one it opens on is picked by what the map
annotates rather than by size: a map is drawn for the construct it was made for,
so the features inside the insert are that construct's tags and sites while the
vector's own resistance gene sits there as one unannotated block. Ranking on
(not a vector gene, features inside, length) is what takes T7 over lacI on a pET
backbone and CMV over AmpR on a mammalian one. Where it picks wrong the menu has
the others, and switching rebuilds the panel.

**The frame comes from the sequence, not from the CDS feature.** One of these
example files carries a CDS whose annotated start is not an ATG — the real one is
six bases earlier — and translating the feature would print a protein nobody
made. So the bases decide: the first ATG that opens a frame of at least forty
codons within 600 bases of the promoter, and the stop it runs into. The *first*,
because that is how the ribosome reads it, scanning from the cap; not the
longest, because the longest frame near a promoter is often the vector's own gene.

**An IRES makes a second panel, not a second segment.** What follows an IRES is a
separate protein — it comes off its own initiation — and drawing it as a further
segment of the same bar would say the two are made joined. Each further cistron
is added as its own construct panel below the first, and the panels share one
residues-per-millimeter scale — a 239-residue Venus drawn to the same width as an
805-residue channel would undo the one thing this panel is for.

**A 2A is marked, and marked as skipping.** P2A, T2A, E2A and F2A are found by
their sequence and split out as their own segment, with the break put between the
final glycine and the proline, so the proline starts the downstream protein —
which is where it really ends up. The mass line, the caption draft and the record
then read "after the 2A" rather than "after cleavage", because no bond was ever
made for a protease to cut.

**A `.clc` gives its sequence and nothing else.** A CLC Main Workbench file is a
serialized Java object graph whose own classes write themselves, so the features
— their names, their types, their positions — sit behind code only CLC has. The
sequence does not: it is an ordinary Java `byte[]` in the middle of the graph,
two bits a base, and that is what gets read. The arrangement used is the one that
puts the CMV promoter, the resistance gene and the polyA signal of these files
where a map of them says they are.

So a `.clc` is annotated from its own bases: the promoter by sequence — T7, SP6,
T3, CMV, SV40 — and then, inside the frame, the tags, linkers, protease sites and
2A peptides whose sequence is settled. Everything after that is the same code the
annotated formats go through. On `pcDXc3GMS-hLRRC8D.clc` that gives 860 residues,
an HRV 3C site, 245 unnamed residues, a myc and an SBP-tag — which is what the
file's own feature names say it is, in that order. The long unnamed stretch is
the protein, and naming it is yours to do: a fluorophore or an MBP comes in
variants that differ by a few residues, and printing one variant's name over
another is how a figure ends up asserting something nobody did.

Two kinds of `.clc` are refused instead of guessed at. One keeps the sequence
compressed, in something unpublished — four of the nine files in the lab folder
this was written against. The other splits it into several blocks inside one
array, in a layout this does not follow; the declared base count and the array's
size then disagree, which is the check that catches it. Both say so and point at
File ▸ Export ▸ GenBank, which is one menu and loses nothing.

**A FASTA is read the same way**, since it carries a sequence and nothing else
either: the tags, sites and 2A peptides come out of the translation exactly as
they do for a `.clc`. What a FASTA usually also lacks is a promoter, and then the
frame itself has to be picked — every ATG-to-stop of at least a hundred residues,
on both strands, with the one carrying the most recognized tags taken first and
the longest after that. Tags before length, because a plasmid's resistance gene
is long and a construct is not always longer; on the lab's `p7X-C3GH` sequencing
reads that is what puts the 3C site and the decahistidine on the panel instead of
a marker. The frames it did not take stay in the `read from` menu, so the choice
is yours to change, and the panel and the record both say the frame was chosen
here rather than read off a map. Frames running through an `N` are skipped: those
residues would go missing out of the mass without saying so.

**Whether a FASTA is circular** it does not say, so the sequence is asked: a
plasmid carries an origin of replication and a linear fragment does not. Three
cores are looked for — pUC/ColE1, f1, and the pBR322 stretch the pET and pcDNA
families kept — and finding one makes the file circular, so a gene that wraps the
arbitrary point the FASTA starts at is read whole. Guessing circular outright
would invent frames across the join of a sequencing read instead, and half the
files in a lab folder are exactly that; in the folder this was written against
the split is clean, every file over 2 kb carries an origin and no read does. A
file holding more than one sequence is refused with their names rather than read
as its first one.

**The `?` beside a segment asks NCBI what it is.** This is the only thing in
purifig that sends anything off the machine, so it is a button somebody presses
and never a step in reading a map: it asks first, says how many residues are
about to leave, and lets you pick the database — `swissprot` answers sooner and
names things plainly, `nr` knows the engineered proteins swissprot has never
heard of. NCBI hands back a ticket and works its queue in its own
time — twenty minutes is an ordinary afternoon there — so the ticket is kept on
the segment and the `?` picks it up again whenever you press it. Nothing waits
with a tab open, the ticket is saved with the session, and nothing on this side
holds a job to clean up.

What comes back is a list, not a name: eight hits with their identity and how
much of the segment they cover, and the segment is renamed only when you pick
one. Under 100% identity it says so afterwards, because that is the whole
hazard — a Venus is 96% identical to `Green fluorescent protein` and writing
that on the bar would be the figure claiming an experiment nobody ran.

**The cut is taken at the end of the segment that carries it**, which is why the
site presets hold only the residues that stay behind: TEV is ENLYFQ↓G, so the
preset is `ENLYFQ` and the G belongs to whatever follows. Mark any segment with
`✂` and the panel reports the pieces cleavage leaves, in order, N to C. A site
read off a map is trimmed the same way: a map draws HRV 3C as the whole eight
residues LEVLFQGP and the panel cuts it after the Q, because two residues is
154 Da — the difference between a mass that checks against the gel and one that
quietly does not.

**Was it actually cut?** `cut with the protease` is a tick box, offered only on a
construct that has a protease site in it. Untick it and the panel is the chain as
expressed: one mass, no cut marker, and a chromatogram reading from it expects one
species. Tick it and the pieces come back. The same construct is one band before
the cut and two after it, and a panel standing beside the run *before* cleavage
should not be quoting the products.

A 2A neither gets the tick nor obeys it. The ribosome skipped that bond: there is
nothing to add protease to and nothing to leave undone, so a construct carrying
both a 3C site and a P2A still comes apart at the 2A with the box clear, and the
wording stays "after the 2A".

**Residue numbers** are the protein's own. Give a segment the number its first
residue has — 1 for a full-length protein, 45 for a construct that starts
there — and its span is written under it. A tag has none, because nobody numbers
a tag, and leaving the field blank is how that is said.

A name that does not fit inside its segment is written above it with a leader,
and labels that would collide are pushed right, the leader slanting to say which
segment each one belongs to. A 6-residue site is a sliver of a millimeter and no
font goes in it, so on a real construct most of the tags end up labeled this
way. Turning **to scale** off draws every segment the same width instead, which
is the usual thing to do when the tags matter more than the proportions.

## How big a panel is

Under the **x / y** of every selected panel is its size, and the row says which
number is actually the panel's own — because for half of them it is not. A table
and an A₂₈₀ panel take a width and are as tall as their rows; a construct is as
tall as its bar; a gel is scaled uniformly or every apparent mobility in it
changes, so it takes a height and the width follows. A blot drawn to a pinned
**lane mm** has neither — it is as wide as its lanes at that pitch and as tall as
that makes it — so it shows what it came out as and points at the one number
that sets it, `lane mm` in the figure inspector with nothing selected. That is
also why such a blot has no drag handles on the canvas: there is no size on it to
drag, and looking for one is how you end up asking where the size is set.

A chromatogram, a box and a text block are free: **w** and **h** are millimeters
on the page.

## Lining panels up

Select two or more panels and the inspector offers six alignments — left,
center, right, top, middle, bottom — each of which moves everything in the
selection to the outermost panel in that direction. Centering uses the middle of
what the selection spans.

What makes it useful is the **by** menu above them, because a panel has two
edges and figures want both.

**The straight element** is the axis spines of a chromatogram, the border of a
gel, the rules of a table — the edge a reader's eye registers as the edge of the
panel. Line a column of panels up by this and the y-axis of the trace sits
directly over the left border of the gel below it, however wide the tick numbers
happen to be. This is almost always the one you want.

**Everything drawn** takes in the tick numbers, the rotated axis title, the lane
labels, the ladder scale and the fraction bar — the panel's whole footprint. Use
it when a panel has to fit a column of a given width, or clear its neighbor,
since what overhangs is exactly what collides. On a chromatogram the two differ
by about 8 mm on the left.

Both are computed from what the panel actually draws rather than from a stored
rectangle, and text is *measured* rather than estimated from a character count —
a lane label reading `ΔTM2–3 (E273Q)` reserves the width it will really take. An
alignment is one undo step, and one that would move nothing says so instead of
banking an empty step.

## The pasteboard

Anything entirely off the page is on the pasteboard: drawn on screen on a white
card so its labels can be read, saved with the session, and left out of the SVG,
the PNG and the legend draft — which is what a pasteboard is in any layout
program. It is where replicate blots live: measured like any other panel,
counted by the quantification, not in the figure. An export that left panels out
says so, so that a panel which slid off the page is noticed rather than found
missing from a submitted figure. `Integrity…` lists them as replicates, and the
source-data sheet includes them, uncropped.

## Getting the figure out

**`PDF`** is the default and what a journal asks for: one page exactly the size
of the page you laid out, the labels still text, the scans embedded whole and
lossless. Nothing on a lab machine turns an SVG into a PDF — there is no
converter in the Python environment, and macOS's own `sips` rasterizes it to a
JPEG inside a PDF wrapper — so the server prints the very SVG this would have
exported with a headless copy of the browser, which is the same engine that drew
the figure on screen. There is no second renderer to drift from it. Chrome
rounds the paper to its own 1/300 inch grid, which both changes the size and
leaves the bottom edge of the figure off the page, so the page box is written
again exactly afterwards. It needs the backend and a Chrome, Chromium or Edge
somewhere the server can find; without one it says so and SVG still works.

**`SVG`** is the same figure for Illustrator or Inkscape. **`PNG`** rasterizes
it at 300, 600 or 1200 dpi **on a transparent background** — the page is white
on screen because the canvas draws a page, and a figure dropped on a slide or a
poster should take the background it lands on rather than bring a white card
with it. The gels keep their own backgrounds; those are in the scans.

All three are named after the session they came from, so the figure, the session
and the protocol document are one set on disk rather than `figure(3).pdf` among
them; the supplementary sheet adds `_supplementary` so it cannot be submitted as
the figure. An unsaved figure falls back to its title.

## Sessions

`Save` writes a **session**, which is not the same thing as the figure. An
exported SVG is finished: it has lost the crop rectangle, the levels, which lane
was excised, and which fraction the brace ties to which lane. A session keeps all
of it, along with where you were looking on the page and what you had selected,
so reopening puts you back at the desk rather than at the start.

It is a file on disk with a name you chose, not a download that lands in
`~/Downloads` as `figure(4).json`:

| | |
|---|---|
| `Save` ⌘S | writes over the file this session came from, no dialog |
| `as…` ⇧⌘S | choose a folder and a name |
| `Open…` ⌘O | any `.purifig.json`, or a plain figure JSON from before sessions existed |
| `recent…` | the last ten, across restarts |
| `New` | an empty page, after asking about unsaved work |

The name in the toolbar is the file you are in, and a `•` after it means there
are changes it does not have yet. Closing the tab with that dot showing puts up
the browser's own warning; so does opening another session over it, or dropping
one on the canvas.

**Autosave** writes every twenty seconds while there is anything to lose, to
`~/.purifig/autosave.purifig.json` — and deletes it the moment you save
properly. So an autosave existing at startup means exactly one thing: last time,
work was lost. That is what makes the offer to restore it worth reading rather
than something to click past. `not now` leaves it alone and offers again next
time; nothing here throws it away except a real save. With the backend down it
falls back to the browser's own storage, and says so plainly if the figure is
too large for that.

A second copy of the server — for a demonstration, or to try something out —
takes `--state DIR` (or `PURIFIG_STATE`) to keep its autosave elsewhere. Two
copies sharing one would each overwrite the other's, and each clear it on
saving, which is the one thing an autosave must never do.

### What a session does and does not carry

It carries the document, which already includes every panel's rendered image, so
**the figure always draws** — on another machine, after a folder move, with the
originals nowhere in sight.

It does **not** embed the original scans. A 16-bit TIFF is thirty megabytes and
is already on disk; the session points at it. Two consequences, both handled:

- A scan you **dropped** on the canvas has no home — the browser hands over bytes
  and no path, so it was written to a temp folder the operating system empties
  when it likes. Saving copies it into a `<name>.files` folder beside the
  session and records the copy. Sessions therefore survive a reboot; sessions
  that reference files you picked off disk stay small.
- A scan that has **moved** is reported on opening. The panel says where it used
  to be and offers **`relink…`**, which points the session at the file's new
  address and keeps the crop, the levels, the lean and the lanes — all of which
  are in source pixels, so they only stay meaningful if the file is the same
  size. A different size is refused with the two dimensions printed, because
  applying an old crop to a new scan silently shows the wrong part of the gel.
  Replacing a scan on purpose is `change image…`, which is a different act and
  throws the crop away.

## The record

**`Integrity…`** is the whole reason for the app. It prints, per panel: the
source file and its bit depth, the crop in source pixels, the orientation, the
black/white/gamma and whether that is linear, how much was clipped at each end,
how many lanes the source had and how many are shown, exactly which lanes were
removed and what they were, how many splices resulted and whether they are
marked, the ladder and its fit, and the antibody or stain. For a blot, the
white-light image and which picture the sizes were read from, whether the panel
is a composite, the strips shown, and every measured box with its value; for a
quantification, what was divided by what, relative to which condition, from
which blots, and what was left out. Then a **Checks** block for the things that
need declaring — non-linear adjustment, clipped bands, a saturated source scan,
an unmarked splice, a missing ladder, a poor fit, a strip with no size on it, a
saturated band, fewer than three blots.

None of it is remembered separately. A crop, a window, an excision and a splice
are document state, so the report is derived from the figure rather than
maintained beside it, and the two cannot drift apart.

**`Source data`** builds the supplementary sheet: every panel's whole uncropped
scan, the crop outlined on it, the excised lanes shaded, and the display
settings printed underneath — and, for blots, the strips outlined, the measured
boxes drawn where the bands are on the original, the white-light image, every
replicate blot that fed a quantification, and the numbers behind each graph.
Save it as HTML and it goes to the journal as-is.

**`Caption…`** drafts the legend from the metadata already entered — column,
buffer, flow rate, standards and their r², lane order, stain, antibody, and a
sentence saying which lanes were removed and that the splice is marked. It is a
draft; check every number against the notebook.

**`Methods…`** drafts the other half: not what the figure shows but how the
numbers in it were got — that measurement reads the original file and never the
displayed panel, what the background under a band was taken to be, what each
quantification is a share or a ratio of, how many blots, what was left out, and
that no statistical test is applied. Where the panels disagree the majority
carries the sentence and the rest become an `, except … (LAMP2)` clause.

**`Protocol…`** is the purification itself, which the app does not otherwise
know. A protocol in this lab is a Word file: headings with a date on them,
steps under them, and -- in a color that is not the body's -- what actually
happened on the day. That color is the whole of the import. It is the line
between the recipe, which is the same every time, and the one experiment the
figure is about, and both a whole line and a number written over the recipe's
own come across: the first as `> a comment`, the second as `*a marked span*`.

What comes in is text and stays text — `# title`, `## heading`, `- step`, two
spaces for a line belonging to the step above it, `>`, `*…*` — so editing it
here is editing a protocol rather than filling in a form, and editing is also
the repair for every heading the reader guessed wrong (which lines are headings
is a guess; dates and section words are certain, a short line standing over a
list is not). It is saved in the session.

Exporting writes **one document**, `.docx` or `.pdf`: the title, an overview —
the days, the steps under each and how many of them this experiment had
something to say about, then the figure's panels letter by letter — the figure
itself at the size it was drawn, its legend, and the protocol with the comments
back in their color. It goes beside the session and never writes over a
document already there; the same name twice gets a `-2`.

## What is deliberately not here

- **Per-region adjustment.** There is one window per panel. Dodging one lane is
  the manipulation the guidelines are actually written about, and an app that
  makes it convenient will get used to do it.
- **Lane reordering.** Lanes render in the order they were run. Rearranging them
  is a claim that needs a splice mark at every seam and a sentence in the legend;
  it is not a layout convenience.
- **A brightness slider that does not say what it did.** Every pixel operation
  here has a number, and the number reaches the record.
- **A window per strip.** Strips cut from one image share its one window. A
  loading control that needs a different contrast from its target needs a
  different exposure, and that is a second panel.

## Example assets

```bash
python3 examples/make_example_gel.py
```

writes a synthetic 16-bit gel — twelve lanes, a nine-rung ladder, a lysate, a
flow-through, a loading control and seven peak fractions — so the gel panel has
something to open. It is generated, not measured; it exists to exercise the
code paths.

```bash
python3 examples/make_example_sec.py
```

writes the same synthetic SEC run in both text shapes — `example_sec.asc` in the
UNICORN one (UTF-16, paired columns, a fractions column whose labels are digits)
and `example_sec.csv` in the plain one. Loading either should give the same
panel; that is what they are for.

There is no generator for a binary `.RES`: writing one would only test the
reader against my own idea of the format. That reader was worked out against
real ÄKTAprime files and is checked against what the run itself says — the
fraction table lands where the method's `Frac` breakpoint puts it, and the
trace's last point lands where flow × duration puts it.

```bash
python3 examples/make_example_western.py
```

writes three synthetic western blots into `examples/western/`, each as the pair
an imager takes — `western_repN_chemi.tif` and `western_repN_white.tif` — with
`western_truth.json` recording what quantification ought to find. Each band is
drawn from its own term, so its true signal is summed exactly. They are awkward
the way real ones are: the ladder is only in the white light; each blot was
loaded unevenly and exposed differently; the lanes lean, by a different amount
on each membrane; blot 3's signal was binned 2×2, so it is half the size of its
white light; and blot 3's loading control in lane C is overloaded and clips.
Through the app, every lane of every blot comes back within 0.7% of the recorded
answer and every condition's mean within 0.4%, the ladder is found at ten rungs
of ten on all three, and the clipped lane is flagged and left out.

`examples/nanodrop_2000.tsv` and `examples/nanodrop_one.csv` are the two shapes
spectrophotometer software writes — different headings, different columns, the
same measurement — for checking that the importer reads both. The 2000 one is
deliberately left on "1 Abs = 1 mg/mL", so importing it against a real sequence
shows the disagreement the panel is there to catch.

`Example` in the toolbar builds a figure around a synthetic chromatogram, with
an empty gel panel waiting for that TIFF.

## Not done yet

- The construct's mass read against the gel beside it: the ladder already gives
  a band its apparent kDa and the construct already knows what it should be, and
  nothing compares them — which is what a membrane protein running light, or a
  band at the tag's mass, would show
- One sequence shared between the construct and the A₂₈₀ panel, rather than
  pasted into each
- Lane profile plots as a panel type — the densitometry is computed and shown
  per lane, but there is nowhere yet to draw it
- SEC-MALS: a molar-mass trace across a peak, on the right-hand axis
- nanoDSF / Tm and mass photometry panels
- Reading the fraction↔lane mapping straight from the brace, so the lane labels
  fill in from the pooled range instead of being typed
- UNICORN 5/6 `.zip` results — a different container from the 3.x `.RES` here
- Peak integration: areas and a percentage per peak, from the trace rather than
  from UNICORN's own evaluation
- Distributing panels at equal spacing, alongside aligning them
- Aligning to a nominated panel rather than to the outermost one in the selection
- Total-protein normalization — dividing by a stain-free or Ponceau image of the
  whole lane rather than by one housekeeping band
- Lanes found automatically on a membrane: there is no comb to find them by, so a
  blot's lanes are set by dragging the two outer boundaries
- Statistics between conditions. `numbers…` is where to take them from; a test
  on ratios fixed at 1 for the control needs choosing with that in mind

## Checks

```bash
python3 test_purifig.py
```

covers the two server decisions that would fail quietly: the image cache has to
hold three replicates and their white light at once and evict least-recently-used
under a budget in bytes, and the PNG level has to stay lossless. It also covers
two decisions that only a real file exercises: the ladder finder has to skip the
comb and keep every rung, on gels cropped both loose (comb below the old fixed
blank, where it used to be read as a rung) and tight (top rung above it, where it
used to be thrown away); and a plasmid map has to read into segments that account
for every residue of the ORF in order, with the 3C site trimmed at the scissile
bond and the 2A split before its final proline. Everything else
is checked against `examples/western/western_truth.json` by measuring it, which
is what that file is for.

```bash
python3 protocol.py
```

round-trips a protocol through the Word reader and both writers: the five kinds
of line come back as themselves, a comment comes back in the color it went out
in, the overview counts the days and the steps under them, and the figure is
really in the .docx rather than merely referenced by it. `python3 protocol.py
some.docx` prints what it reads out of a real one.

```bash
node test_construct.js
```

covers the construct panel's arithmetic, which reaches a figure: a counted mass
has to be the real one, an estimated mass has to say that it is, the water that
closes a chain has to be added once per piece rather than once per segment, and
a cut has to split the construct where the site is rather than one segment out.
Unticking the cut has to leave the chain whole — mass line, cut marker, and the
species a column is asked for — without also undoing a 2A.

```bash
node test_tilt.js
```

covers leveling a gel by the two ladders run on it — mostly the sign, since an
angle the wrong way round doubles the tilt instead of taking it off: turning the
rungs by the measured angle has to put every pair at one height. One rung clicked
on the wrong band must not decide the angle, one ladder is not two however many
rungs are on it, and the size scale beside the panel still prints each size once.
It also covers the panel title clearing its lane labels: where it has always sat
for one straight line, higher for a second line or a slanted row. And it covers
which membrane a crop came off, for the supplementary sheet: the piece the crop's
middle is on, grown over a cut line only as far as the crop reaches, and nothing
at all for a crop that is on no membrane. Last, a gel cut in two on a lane: each
part has to be one unbroken run drawing no splice, each has to recognize the
other as its other half while a panel keeping a lane it also keeps does not, a
lane taken out of the middle still has to splice, and a thicker size bar has to
push the numbers out by exactly as much as it grew.

```bash
node test_table.js
```

covers what the purification table works out for itself: a step named like a
sample in the A₂₈₀ panel has to take that panel's volume and milligrams, the
second reading of one name must not quietly replace the first, target has to be
what the purity says of the total and yield has to be against the first step —
and a step nothing measured has to keep what was typed into it. A measured
purity has to replace a typed one and carry through to both; a whole lane with
no band measured in it is not a purity of zero, and the typed number has to come
back. Last, that none of it is written back: turning the derivation off has to
print the typed table exactly as it was.

```bash
node test_quant.js
```

covers what a quantification does with the same label in two lanes of one gel.
`separate` has to count them both towards n with their own values, `averaged`
has to give that gel one point at their mean, and either way the gel has to be
normalized by the mean of its reference lanes — so that loading the control
twice does not move every other bar.

The `.clc` check is in `test_purifig.py` instead, because what it is checking is
a file: bases packed two to a byte have to come back out as the bases that went
in, and a file whose array holds more than one block has to be refused rather
than read into a plausible wrong sequence.

## Shared parts

The palette, buttons, file dialog and dark/light toggle come from `labkit`,
vendored here by `python -m labkit.sync purifig`. `labkit.css` and `labkit.js`
in this folder are generated — edit `labkit/theme.py` or
`labkit/static/components.css` and re-run the sync.

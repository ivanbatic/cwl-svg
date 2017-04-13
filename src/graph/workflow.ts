import {Edge, StepModel, WorkflowModel, WorkflowStepInputModel, WorkflowStepOutputModel} from "cwlts/models";
import "snapsvg-cjs";
import {DomEvents} from "../utils/dom-events";
import {EventHub} from "../utils/event-hub";
import {Geometry} from "../utils/geometry";
import {Edge as GraphEdge} from "./edge";
import {GraphNode} from "./graph-node";
import {IOPort} from "./io-port";
import {TemplateParser} from "./template-parser";

Snap.plugin(function (Snap, Element) {
    const proto = Element.prototype;

    proto.toFront = function () {
        this.appendTo(this.node.parentNode);
    };
    proto.toBack  = function () {
        this.prependTo(this.node.parentNode);
    };
});

export class Workflow {
    private paper: Snap.Paper;

    private group: Snap.Element;

    private scale: number = 1;

    public readonly eventHub: EventHub;

    private domEvents: DomEvents;

    private workflow: SVGGElement;

    private svgRoot: SVGSVGElement;

    private model: WorkflowModel;

    private workflowBoundingClientRect;

    private isDragging: boolean = false;

    /**
     * The size of the workflow boundary / padding that stops nodes from being dragged
     * outside the workflow viewport; drag "scroll" is activated when cursor hits a boundary
     * @type {number}
     */
    private dragBoundary: number = 50;

    /**
     * The amount which the workflow, node, and necessary paths will be translated
     * when mouse is dragged on boundary or outside workflow every time the interval runs
     * @type {number}
     */
    private dragBoundaryTranslation: number = 5;

    /**
     * The interval that is set when the cursor hits a boundary (or multiple boundaries)
     * x and y represent the axes on which the boundary is hit, the interval is the interval
     * function itself, and xOffset and yOffset represent the accumulated translations
     */
    private dragBoundaryInterval = {
        x: false,
        y: false,
        interval: null,
        xOffset: 0,
        yOffset: 0,
        highlightedPort: undefined
    };

    constructor(paper: Snap.Paper, model: WorkflowModel) {
        this.paper = paper;

        this.svgRoot = paper.node;

        this.model = model;

        this.domEvents = new DomEvents(this.paper.node as HTMLElement);

        this.paper.node.innerHTML = `
            <rect x="0" y="0" width="100%" height="100%" class="pan-handle" transform="matrix(1,0,0,1,0,0)"></rect>
            <g class="workflow" transform="matrix(1,0,0,1,0,0)"></g>
        `;

        this.workflow = this.paper.node.querySelector(".workflow") as any;

        this.group = Snap(this.workflow);

        this.paper.node.addEventListener("mousewheel", ev => {
            // Cancel the mousewheel event if a drag event is currently being handled
            if (this.isDragging) {
                return;
            }

            const scale = this.scale + ev.deltaY / 500;

            // Prevent scaling to unreasonable proportions.
            if (scale <= 0.15 || scale * scale > 3) {
                return;
            }

            this.scaleWorkflow(scale, ev);
            ev.stopPropagation();
        }, true);

        this.eventHub = new EventHub([
            /** @link connection.create */
            "connection.create",
            /** @link app.create.step */
            "app.create.step",
            /** @link app.create.input */
            "app.create.input",
            /** @link app.create.output */
            "app.create.output",
            /** @link workflow.arrange */
            "workflow.arrange",
            /** @link workflow.scale */
            "workflow.scale",
            /** @link workflow.fit */
            "workflow.fit",
            "beforeChange",
        ]);

        this.attachEvents();

        if (model) {
            this.renderModel(model);
        }
        console.time("Event Listeners");

        console.timeEnd("Event Listeners");
    }

    command(event: string, ...data: any[]) {
        this.eventHub.emit(event, ...data);
    }

    on(event: string, handler) {
        this.eventHub.on(event, handler);
    }

    off(event, handler) {
        this.eventHub.off(event, handler);
    }

    getScale() {
        return this.scale;
    }

    /**
     * Scales the workflow to fit the available viewport
     */
    fitToViewport(): void {
        this.scaleWorkflow(1);
        Object.assign(this.workflow.transform.baseVal.getItem(0).matrix, {
            e: 0,
            f: 0
        });

        let clientBounds = this.svgRoot.getBoundingClientRect();
        let wfBounds     = this.workflow.getBoundingClientRect();
        const padding    = 200;

        if (clientBounds.width === 0 || clientBounds.height === 0) {
            throw new Error("Cannot fit workflow to the area that has no visible viewport.");
        }

        const verticalScale   = (wfBounds.height) / (clientBounds.height - padding);
        const horizontalScale = (wfBounds.width) / (clientBounds.width - padding);

        const scaleFactor = Math.max(verticalScale, horizontalScale);

        // Cap the upscaling to 1, we don't want to zoom in workflows that would fit anyway
        const newScale = Math.min(this.scale / scaleFactor, 1);
        this.scaleWorkflow(newScale);

        const scaledWFBounds = this.workflow.getBoundingClientRect();

        const moveY = newScale * (clientBounds.top - scaledWFBounds.top + Math.abs(clientBounds.height - scaledWFBounds.height) / 2);
        const moveX = newScale * (clientBounds.left - scaledWFBounds.left + Math.abs(clientBounds.width - scaledWFBounds.width) / 2);


        const matrix = this.workflow.transform.baseVal.getItem(0).matrix;
        matrix.e     = moveX;
        matrix.f     = moveY;
    }

    private renderModel(model: WorkflowModel) {
        console.time("Graph Rendering");
        const oldTransform = this.workflow.getAttribute("transform");
        let selectedStuff = this.workflow.querySelectorAll(".selected");
        if (selectedStuff.length) {
            selectedStuff = selectedStuff.item(0).getAttribute("data-connection-id");
        } else {
            selectedStuff = undefined;
        }

        this.clearCanvas();

        this.workflow.setAttribute("transform", "matrix(1,0,0,1,0,0)");

        const nodes    = [...model.steps, ...model.inputs, ...model.outputs].filter(n => n.isVisible);
        const nodesTpl = nodes.map(n => GraphNode.patchModelPorts(n))
            .reduce((tpl, nodeModel: any) => {
                const x = nodeModel.customProps["sbg:x"] || Math.random() * 500;
                const y = nodeModel.customProps["sbg:y"] || Math.random() * 500;
                return tpl + GraphNode.makeTemplate(x, y, nodeModel);
            }, "");

        this.workflow.innerHTML += nodesTpl;

        const edgesTpl = model.connections.map(c => GraphEdge.makeTemplate(c, this.paper)).reduce((acc, tpl) => acc + tpl, "");
        this.workflow.innerHTML += edgesTpl;
        console.timeEnd("Graph Rendering");
        console.time("Ordering");


        this.workflow.querySelectorAll(".node").forEach(e => {
            this.workflow.appendChild(e);
        });

        this.addEventListeners(this.paper.node);

        this.workflow.setAttribute("transform", oldTransform);
        console.timeEnd("Ordering");
        this.scaleWorkflow(this.scale);

        const newSelection = this.workflow.querySelector(`[data-connection-id='${selectedStuff}']`);
        if (newSelection) {
            this.activateSelection(newSelection as SVGGElement);
        }
    }

    static canDrawIn(element: SVGElement): boolean {
        let clientBounds = element.getBoundingClientRect();
        console.log("Checking if drawable", clientBounds, element.getClientRects());
        return clientBounds.width !== 0;
    }

    redraw(model?: WorkflowModel) {
        if (model) {
            this.model = model;
        }
        this.renderModel(this.model);
    }

    private attachEvents() {

        this.model.on("step.change", (change: StepModel) => {
            const title = this.workflow.querySelector(`.node.step.${change.connectionId} .title`) as SVGTextElement;
            if (title) {
                title.textContent = change.label;
            }
        });

        /**
         * @name app.create.input
         */
        this.eventHub.on("app.create.input", (input: WorkflowStepInputModel) => {
            this.command("app.create.step", Object.assign(input, {
                out: [{
                    id: input.id,
                    connectionId: input.connectionId,
                    isVisible: true
                }]
            }))
        });

        /**
         * @name app.create.output
         */
        this.eventHub.on("app.create.output", (output: WorkflowStepOutputModel) => {
            this.command("app.create.step", Object.assign(output, {
                in: [{
                    id: output.id,
                    connectionId: output.connectionId,
                    isVisible: true
                }]
            }))
        });

        /**
         * @name app.create.step
         */
        this.eventHub.on("app.create.step", (step: StepModel) => {

            const x   = step.customProps["sbg:x"] || Math.random() * 1000;
            const y   = step.customProps["sbg:y"] || Math.random() * 1000;
            const tpl = GraphNode.makeTemplate(x, y, step);
            const el  = TemplateParser.parse(tpl);
            this.workflow.appendChild(el);

            // Labels on this new step will not be scaled properly since they are custom-adjusted during scaling
            // So let's trigger the scaling again
            this.scaleWorkflow(this.scale);
        });

        /**
         * @name connection.create
         */
        this.eventHub.on("connection.create", (connection: Edge) => {

            // this.workflow.innerHTML += GraphEdge.makeTemplate(connection, this.paper);
        });

        /**
         * @name workflow.arrange
         */
        this.eventHub.on("workflow.arrange", (connections: Edge[]) => {
            const tracker = {};
            const zones   = {};
            const width   = this.paper.node.clientWidth;
            const height  = this.paper.node.clientHeight;

            const workflowIns = new Map<any[], string>();

            connections.forEach(c => {

                let [, sName, spName] = c.source.id.split("/");
                let [, dName, dpName] = c.destination.id.split("/");

                tracker[sName] || (tracker[sName] = []);
                (tracker[dName] || (tracker[dName] = [])).push(tracker[sName]);
                if (sName === spName) {
                    workflowIns.set(tracker[sName], sName);
                }
            });

            const trace = (arr, visited: Set<any>) => {
                visited.add(arr);
                return 1 + ( arr.length ? Math.max(...arr.filter(e => !visited.has(e)).map((e) => trace(e, visited))) : 0);
            };


            const trackerKeys = Object.keys(tracker);
            const idToZoneMap = trackerKeys.reduce(
                (acc, k) => Object.assign(acc, {[k]: trace(tracker[k], new Set()) - 1}), {}
            );

            trackerKeys.forEach(k => {
                tracker[k].filter(p => workflowIns.has(p)).forEach(pre => {
                    idToZoneMap[workflowIns.get(pre)] = idToZoneMap[k] - 1;
                });
            });

            trackerKeys.forEach(k => {

                try {
                    const snap = Snap(`.node.${k}`);
                    const zone = idToZoneMap[k];
                    if (!snap) {
                        throw new Error("Cant find node " + k);
                    }
                    (zones[zone] || (zones[zone] = [])).push(snap);
                } catch (ex) {
                    console.error("ERROR", k, ex, tracker);
                }
            });

            const columnCount = Object.keys(zones).length + 1;
            const columnWidth = (width / columnCount);

            for (let z in zones) {
                const rowCount  = zones[z].length + 1;
                const rowHeight = height / rowCount;

                zones[z].forEach((el: Snap.Element, i) => {
                    el.transform(new Snap.Matrix()
                        .translate(columnWidth * (~~z + 1), (i + 1) * rowHeight));
                });
            }
        });
    }

    scaleWorkflow(scaleCoefficient: number = 1, ev?: { clientX: number, clientY: number }) {
        this.scale              = scaleCoefficient;
        const transform         = this.workflow.transform.baseVal;
        const matrix: SVGMatrix = transform.getItem(0).matrix;

        const coords = this.translateMouseCoords(ev ? ev.clientX : 0, ev ? ev.clientY : 0);

        matrix.e += matrix.a * coords.x;
        matrix.f += matrix.a * coords.y;
        matrix.a = matrix.d = scaleCoefficient;
        matrix.e -= scaleCoefficient * coords.x;
        matrix.f -= scaleCoefficient * coords.y;

        const labelScale = 1 + (1 - this.scale) / (this.scale * 2);

            Array.from(this.workflow.querySelectorAll(".node .label"))
                .map((el: SVGGElement) => el.transform.baseVal.getItem(0).matrix)
                .forEach(m => {
                    m.a = labelScale;
                    m.d = labelScale;
                });

        /**
         * @name workflow.fit
         */
        this.eventHub.on("workflow.fit", () => {

            this.group.transform(new Snap.Matrix());

            let {clientWidth: paperWidth, clientHeight: paperHeight} = this.paper.node;
            let clientBounds                                         = this.paper.node.getBoundingClientRect();
            let wfBounds                                             = this.group.node.getBoundingClientRect();

            const padding = 200;

            const verticalScale   = (wfBounds.height + padding) / paperHeight;
            const horizontalScale = (wfBounds.width + padding) / paperWidth;

            const scaleFactor = Math.max(verticalScale, horizontalScale);

            this.command("workflow.scale", 1 / scaleFactor);

            let paperBounds = this.paper.node.getBoundingClientRect();
            wfBounds        = this.group.node.getBoundingClientRect();

            const moveY = scaleFactor * -wfBounds.top + scaleFactor * clientBounds.top + scaleFactor * Math.abs(paperBounds.height - wfBounds.height) / 2;
            const moveX = scaleFactor * -wfBounds.left + scaleFactor * clientBounds.left + scaleFactor * Math.abs(paperBounds.width - wfBounds.width) / 2;

            this.group.transform(this.group.transform().localMatrix.clone().translate(moveX, moveY));
        });
    }

    private addEventListeners(root: HTMLElement): void {

        /**
         * Whenever a click happens on a blank space, remove selections
         */
        this.domEvents.on("click", "*", (ev, el, root) => {
            this.deselectEverything();
        });

        /**
         * Whenever a click happens on a node, select that node and
         * highlight all connecting edges and adjacent vertices
         * while shadowing others.
         */
        this.domEvents.on("click", ".node", (ev, el) => {
            this.activateSelection(el);
        });

        /**
         * Move nodes and edges on drag
         */
        {
            let startX: number;
            let startY: number;
            let inputEdges: Map<SVGElement, number[]>;
            let outputEdges: Map<SVGElement, number[]>;
            let newX: number;
            let newY: number;

            this.domEvents.drag(".node .drag-handle", (dx: number, dy: number,
                                                       ev: any, handle: SVGGElement): any => {
                const el  = handle.parentNode;
                let sdx, sdy;

                const boundary = this.getBoundaryZonesXYAxes(ev.clientX, ev.clientY);

                // if a workflow boundary has been hit, then call function which calls the interval
                if (boundary.x || boundary.y) {
                    this.setDragBoundaryIntervalIfNecessary(el, { x: boundary.x, y: boundary.y },
                        { startX: startX, startY: startY, inputEdges: inputEdges, outputEdges: outputEdges });
                }

                // returns the delta x and y - change in node position - based on mouse position and
                // boundary offsets (if necessary)
                const scaledDeltas = this.getScaledDeltaXYForDrag(boundary, ev, startX, startY, dx, dy);
                sdx = scaledDeltas.x;
                sdy = scaledDeltas.y;
                newX = startX + sdx;
                newY = startY + sdy;
                el.transform.baseVal.getItem(0).setTranslate(newX, newY);

                this.setInputAndOutputEdges(inputEdges, outputEdges, sdx, sdy);
            }, (ev, handle, root) => {
                this.isDragging = true;
                const el     = handle.parentNode;
                const matrix = el.transform.baseVal.getItem(0).matrix;
                startX       = matrix.e;
                startY       = matrix.f;
                inputEdges   = new Map();
                outputEdges  = new Map();
                this.workflowBoundingClientRect = this.svgRoot.getBoundingClientRect();

                Array.from(root.querySelectorAll(`.edge[data-destination-node='${el.getAttribute("data-id")}'] .sub-edge`))
                    .forEach((el: SVGElement) => {
                        inputEdges.set(el, el.getAttribute("d").split(" ").map(e => Number(e)).filter(e => !isNaN(e)))
                    });

                Array.from(root.querySelectorAll(`.edge[data-source-node='${el.getAttribute("data-id")}'] .sub-edge`))
                    .forEach((el: SVGElement) => {
                        outputEdges.set(el, el.getAttribute("d").split(" ").map(e => Number(e)).filter(e => !isNaN(e)))
                    });
            }, (ev, target) => {
                this.isDragging = false;
                this.setDragBoundaryIntervalToDefault();

                const parentNode = Workflow.findParentNode(target);

                const model = this.model.findById(parentNode.getAttribute("data-connection-id"));
                if (model) {
                    this.setModelPosition(model, newX, newY);
                }

                inputEdges  = undefined;
                outputEdges = undefined;
            });
        }

        /**
         * Attach canvas panning
         */
        {
            let pane: SVGElement;
            let x;
            let y;
            let matrix: SVGMatrix;
            this.domEvents.drag(".pan-handle", (dx, dy, ev, el, root) => {

                matrix.e = x + dx;
                matrix.f = y + dy;

            }, (ev, el, root) => {
                pane   = root.querySelector(".workflow") as SVGElement;
                matrix = pane.transform.baseVal.getItem(0).matrix;
                x      = matrix.e;
                y      = matrix.f;
            }, () => {
                pane   = undefined;
                matrix = undefined;
            });
        }

        /**
         * Edge Selection
         */
        this.domEvents.on("click", ".edge", (ev, target, root) => {
            this.highlightEdge(target);
            target.classList.add("selected");
        });

        /**
         * Manually wire up hovering on edges because mouseenters don't propagate
         */
        {
            Array.from(this.workflow.querySelectorAll(".edge")).forEach((el: SVGGElement) => {
                this.attachEdgeHoverBehavior(el);
            });
        }

        /**
         * On mouse over node, bring it to the front
         */
        this.domEvents.on("mouseover", ".node", (ev, target, root) => {
            if (this.workflow.querySelector(".edge.dragged")) {
                return;
            }
            target.parentElement.appendChild(target);
        });

        this.attachPortDragBehavior();

        this.attachSelectionDeletionBehavior();
    }

    /**
     * Sets the interval for dragging within a boundary zone if a new
     * boundary zone has been hit. The interval function translates the workflow,
     * the dragging node, and the edges attached to that node.
     * @param el
     * @param boundary
     * @param pathInfo
     * @param ghostIO
     */
    private setDragBoundaryIntervalIfNecessary(el: SVGElement,
                                               boundary: { x: 1 | 0 | -1, y: 1 | 0 | -1 },
                                               pathInfo?: { startX: number, startY: number,
                                           inputEdges: Map<SVGElement, number[]>,
                                           outputEdges: Map<SVGElement, number[]> },
                                               ghostIO?: { edge: SVGPathElement, nodeToMouseDistance: number,
                                           allConnectionPorts: SVGGElement[], highlightedPort: SVGGElement,
                                           origin: { x: number, y: number },
                                           coords: { x: number, y: number }
                                           edgeDirection: "left" | "right" }): void {

        // If boundary areas overlap or if boundary areas take up half - or more - of the svg, resize dragBoundary
        while (this.workflowBoundingClientRect.right - this.dragBoundary <= this.workflowBoundingClientRect.left + this.dragBoundary ||
            this.workflowBoundingClientRect.right <= this.workflowBoundingClientRect.left + (this.dragBoundary * 4)) { // CHANGE HERE
            this.dragBoundary = this.dragBoundary / 2;
        }

        const checkIfLeftBoundary: boolean = boundary.x === -1;
        const checkIfRightBoundary: boolean = boundary.x === 1;
        const checkIfTopBoundary: boolean = boundary.y === -1;
        const checkIfBottomBoundary: boolean = boundary.y === 1;

        if (boundary.x || boundary.y) {
            // If mouse has hit a boundary but 'this.dragBoundaryInterval' has not registered it yet,
            // or if both are registered - which happens in corner case - but mouse has been moved to
            // hit only one boundary afterwards
            if (!this.dragBoundaryInterval.x && boundary.x ||
                !this.dragBoundaryInterval.y && boundary.y ||
                (this.dragBoundaryInterval.x && this.dragBoundaryInterval.y && !(boundary.x && boundary.y))) {
                this.dragBoundaryInterval.x = boundary.x !== 0;
                this.dragBoundaryInterval.y = boundary.y !== 0;

                const workflowMatrix: SVGMatrix = this.workflow.transform.baseVal.getItem(0).matrix;
                const mx = el.transform.baseVal.getItem(0).matrix;

                if (ghostIO) {
                    this.dragBoundaryInterval.highlightedPort = ghostIO.highlightedPort;
                }

                // Create new interval every time mouse hits new edge
                clearInterval(this.dragBoundaryInterval.interval);
                this.dragBoundaryInterval.interval = setInterval(() => {
                    const moveX = checkIfRightBoundary ? this.dragBoundaryTranslation :
                        checkIfLeftBoundary ? -this.dragBoundaryTranslation : 0;
                    const moveY = checkIfBottomBoundary ? this.dragBoundaryTranslation :
                        checkIfTopBoundary ? -this.dragBoundaryTranslation : 0;

                    // Change matrix e and f values - these represent x and y translate, respectively -
                    // by 'this.dragBoundaryTranslation' every time this function is called. This translates the matrix
                    // when the mouse down held on an edge.
                    workflowMatrix.e -= moveX;
                    workflowMatrix.f -= moveY;

                    this.dragBoundaryInterval.xOffset += this.adaptToScale(moveX);
                    this.dragBoundaryInterval.yOffset += this.adaptToScale(moveY);

                    // Translates the node by scaled 'moveX' (and/or 'moveY') every time
                    // this interval function is called.
                    mx.e += this.adaptToScale(moveX);
                    mx.f += this.adaptToScale(moveY);

                    // If node has edges - i.e. if it is not a ghost node
                    if (pathInfo) {
                        // Sets the paths correctly for the input edges and the output edges where necessary
                        this.setInputAndOutputEdges(pathInfo.inputEdges, pathInfo.outputEdges,
                            mx.e - pathInfo.startX, mx.f - pathInfo.startY);
                    }
                    else if (ghostIO) {
                        // Creates the ghost node path
                        Array.from(ghostIO.edge.children).forEach((el: SVGPathElement) => {
                            el.setAttribute("d",
                                IOPort.makeConnectionPath(
                                    ghostIO.origin.x,
                                    ghostIO.origin.y,
                                    mx.e,
                                    mx.f,
                                    ghostIO.edgeDirection
                                )
                            );
                        });

                        const sorted = this.getSortedConnectionPorts(ghostIO.allConnectionPorts,
                            { x: mx.e, y: mx.f });
                        this.removeHighlightedPort(this.dragBoundaryInterval.highlightedPort, ghostIO.edgeDirection);
                        this.dragBoundaryInterval.highlightedPort = this.highlightPortOrShowGhostNode(el,
                            sorted, ghostIO.nodeToMouseDistance, ghostIO.edgeDirection, { x: mx.e, y: mx.f});
                    }
                }, 1000 / 60);
            }
        }
    }

    /**
     * Check all possible workflow boundaries to see if (x,y) is on edge(s)
     * -1 / 1 values are left / right and top / bottom depending on the axis,
     * and 0 means it has not hit a boundary on that axis
     * @param x
     * @param y
     * @returns {{x: number, y: number}}
     */
    private getBoundaryZonesXYAxes(x: number, y: number): { x: 1 | 0 | -1, y: 1 | 0 | -1 } {
        const isLeftBoundary = x < this.workflowBoundingClientRect.left + this.dragBoundary;
        const isRightBoundary = x > this.workflowBoundingClientRect.right - this.dragBoundary;
        const isTopBoundary = y < this.workflowBoundingClientRect.top + this.dragBoundary;
        const isBottomBoundary = y > this.workflowBoundingClientRect.bottom - this.dragBoundary;

        // if cursor is not on a boundary, then clear interval if it exists
        if (!isLeftBoundary && !isRightBoundary &&
            !isTopBoundary && !isBottomBoundary) {
            if (this.dragBoundaryInterval.interval) {
                clearInterval(this.dragBoundaryInterval.interval);
                this.dragBoundaryInterval.x = this.dragBoundaryInterval.y = false;
                this.dragBoundaryInterval.interval = null;
                this.dragBoundaryInterval.highlightedPort = undefined;
            }
        }


        // return -1 if (x,y) is on left / top edge or outside the window on the left / top side,
        // return 1 if opposite, and 0 if cursor is in the main part of the canvas (standard), for each axis
        return {
            x: isLeftBoundary ? -1 : isRightBoundary ? 1 : 0,
            y: isTopBoundary ? -1 : isBottomBoundary ? 1 : 0
        };
    }

    /**
     * Calculates the change in x and y for drag, taking into account the starting x and y,
     * the cursor position, the boundary offsets, and the current scale coefficient.
     * @param boundary
     * @param ev
     * @param startX
     * @param startY
     * @param dx
     * @param dy
     * @returns {{x: number, y: number}}
     */
    private getScaledDeltaXYForDrag(boundary: { x: 1 | 0 | -1, y: 1 | 0 | -1 },
                                    ev: {clientX: number, clientY: number},
                                    startX: number, startY: number,
                                    dx: number, dy: number): { x: number, y: number } {
        const edgeIntervalOn = this.dragBoundaryInterval.interval !== null;
        let sdx, sdy;

        if (boundary.x !== 0 || boundary.y !== 0) {
            if (boundary.x !== 0) {
                const edgeX = this.translateMouseCoords(boundary.x === 1 ?
                    this.workflowBoundingClientRect.right - this.dragBoundary :
                    this.workflowBoundingClientRect.left + this.dragBoundary, 0).x; // CHANGE HERE
                sdx = edgeX - startX;
            } else {
                sdx = this.adaptToScale(dx) + this.dragBoundaryInterval.xOffset;
            }
            if (boundary.y !== 0) {
                const edgeY = this.translateMouseCoords(0, boundary.y === 1 ?
                    this.workflowBoundingClientRect.bottom - this.dragBoundary :
                    this.workflowBoundingClientRect.top + this.dragBoundary).y; // CHANGE HERE
                sdy = edgeY - startY;
            } else {
                sdy = this.adaptToScale(dy) + this.dragBoundaryInterval.yOffset;
            }

        } else {
            sdx = this.adaptToScale(dx) + this.dragBoundaryInterval.xOffset;
            sdy = this.adaptToScale(dy) + this.dragBoundaryInterval.yOffset;
        }
        return {
            x: sdx,
            y: sdy
        }
    }

    /**
     * Updates a node's input edges based on the node's output ports' locations,
     * and a node's output edges based on the node's input ports' locations
     * @param inputEdges
     * @param outputEdges
     * @param dx
     * @param dy
     */
    private setInputAndOutputEdges(inputEdges: Map<SVGElement, number[]>,
                                   outputEdges: Map<SVGElement, number[]>,
                                   dx: number,
                                   dy: number) {
        inputEdges.forEach((p: number[], el: SVGElement) => {
            //console.log("p[6]: %d", p[6]);
            el.setAttribute("d", IOPort.makeConnectionPath(p[0], p[1], p[6] + dx, p[7] + dy));
        });

        outputEdges.forEach((p, el) => {
            el.setAttribute("d", IOPort.makeConnectionPath(p[0] + dx, p[1] + dy, p[6], p[7]));
        });
    }

    private highlightEdge(el) {
        const sourceNode = el.getAttribute("data-source-node");
        const destNode   = el.getAttribute("data-destination-node");
        const sourcePort = el.getAttribute("data-source-port");
        const destPort   = el.getAttribute("data-destination-port");

        Array.from(this.workflow.querySelectorAll(
            `.node.${sourceNode} .output-port.${sourcePort}, `
            + `.node.${destNode} .input-port.${destPort}`)).forEach(el => {
            el.classList.add("highlighted");
        });
    }

    private adaptToScale(x) {
        return x * (1 / this.scale);
    }

    public deselectEverything() {
        Array.from(this.workflow.querySelectorAll(".highlighted")).forEach(el => {
            el.classList.remove("highlighted");
        });
        this.workflow.classList.remove("has-selection");
        const selected = this.workflow.querySelector(".selected");
        if (selected) {
            selected.classList.remove("selected");
        }
    }

    public translateMouseCoords(x, y) {
        const svg   = this.paper.node;
        const wf    = svg.querySelector(".workflow");
        const ctm   = wf.getScreenCTM();
        const point = svg.createSVGPoint();
        point.x     = x;
        point.y     = y;

        const t = point.matrixTransform(ctm.inverse());
        return {
            x: t.x,
            y: t.y
        };
    }

    private attachEdgeHoverBehavior(el: SVGGElement) {
        let tipEl;

        this.domEvents.hover(el, (ev, target) => {

            if (!tipEl) {
                return;
            }
            const coords = this.translateMouseCoords(ev.clientX, ev.clientY);
            tipEl.setAttribute("x", coords.x);
            tipEl.setAttribute("y", coords.y - 16);

        }, (ev, target, root) => {
            if (root.querySelector(".dragged")) {
                return;
            }

            const sourceNode = target.getAttribute("data-source-node");
            const destNode   = target.getAttribute("data-destination-node");
            const sourcePort = target.getAttribute("data-source-port");
            const destPort   = target.getAttribute("data-destination-port");

            const sourceLabel = sourceNode === sourcePort ? sourceNode : `${sourceNode} (${sourcePort})`;
            const destLabel   = destNode === destPort ? destNode : `${destNode} (${destPort})`;

            const coords = this.translateMouseCoords(ev.clientX, ev.clientY);

            const ns = "http://www.w3.org/2000/svg";
            tipEl    = document.createElementNS(ns, "text");
            tipEl.classList.add("label");
            tipEl.classList.add("label-edge");
            tipEl.setAttribute("x", coords.x);
            tipEl.setAttribute("y", coords.x - 16);
            tipEl.innerHTML = sourceLabel + " → " + destLabel;

            this.workflow.appendChild(tipEl);

        }, () => {
            if (tipEl) {
                tipEl.remove();
                tipEl = undefined;
            }
        });
    }

    private attachSelectionDeletionBehavior() {
        this.domEvents.on("keyup", (ev: KeyboardEvent) => {

            if (!(ev.target instanceof SVGElement && ev.target.ownerSVGElement === this.svgRoot)) {
                return;
            }

            const selection = Array.from(this.workflow.querySelectorAll(".selected"));
            if (ev.which !== 8 || selection.length === 0) {
                return;
            }

            this.eventHub.emit("beforeChange", {
                type: "deletion",
                data: selection
            });

            selection.forEach(el => {
                if (el.classList.contains("step")) {

                    this.model.removeStep(el.getAttribute("data-connection-id"));
                    this.renderModel(this.model);
                    (this.svgRoot as any).focus();
                } else if (el.classList.contains("edge")) {

                    const sourcePortID      = el.getAttribute("data-source-connection");
                    const destinationPortID = el.getAttribute("data-destination-connection");

                    const sourcePort      = this.workflow.querySelector(`.port[data-connection-id="${sourcePortID}"]`);
                    const destinationPort = this.workflow.querySelector(`.port[data-connection-id="${destinationPortID}"]`);

                    const sourceNode      = Workflow.findParentNode(sourcePort);
                    const destinationNode = Workflow.findParentNode(destinationPort);

                    this.model.disconnect(sourcePortID, destinationPortID);
                    this.renderModel(this.model);
                    (this.svgRoot as any).focus();
                } else if (el.classList.contains("input")) {

                    this.model.removeInput(el.getAttribute("data-connection-id"));
                    this.renderModel(this.model);
                    (this.svgRoot as any).focus();
                } else if (el.classList.contains("output")) {

                    this.model.removeOutput(el.getAttribute("data-connection-id"));
                    this.renderModel(this.model);
                    (this.svgRoot as any).focus();
                }
            });


            // Only input elements can be focused, but we added tabindex to the svg so this works
        }, window);
    }

    private attachPortDragBehavior() {
        let edge: SVGPathElement;
        let preferredConnectionPorts: SVGGElement[];
        let allConnectionPorts: SVGGElement[];
        let highlightedPort: SVGGElement;
        let edgeDirection: "left" | "right";
        let ghostIONode: SVGGElement;
        let originNodeCoords: { x: number, y: number };

        this.domEvents.drag(".port", (dx: number, dy: number, ev, target) => {
            // Gather the necessary positions that we need in order to draw a path
            const ctm                 = target.getScreenCTM();
            const coords              = this.translateMouseCoords(ev.clientX, ev.clientY);
            const origin              = this.translateMouseCoords(ctm.e, ctm.f);
            const nodeToMouseDistance = Geometry.distance(originNodeCoords.x, originNodeCoords.y, coords.x, coords.y);

            const boundary = this.getBoundaryZonesXYAxes(ev.clientX, ev.clientY);

            if (boundary.x || boundary.y) {
                this.setDragBoundaryIntervalIfNecessary(ghostIONode, { x: boundary.x, y: boundary.y }, null,
                    { edge: edge, nodeToMouseDistance: nodeToMouseDistance, allConnectionPorts,
                        highlightedPort, origin, coords, edgeDirection: edgeDirection } );
            }

            const scaledDeltas = this.getScaledDeltaXYForDrag(boundary, ev, origin.x, origin.y, dx, dy);

            // Draw a path from the origin port to the cursor
            Array.from(edge.children).forEach((el: SVGPathElement) => {
                el.setAttribute("d",
                    IOPort.makeConnectionPath(
                        origin.x,
                        origin.y,
                        origin.x + scaledDeltas.x,
                        origin.y + scaledDeltas.y,
                        edgeDirection
                    )
                );
            });

            const sorted = this.getSortedConnectionPorts(allConnectionPorts, coords);
            highlightedPort = this.dragBoundaryInterval.highlightedPort || highlightedPort;
            this.removeHighlightedPort(highlightedPort, edgeDirection);
            highlightedPort = this.highlightPortOrShowGhostNode(ghostIONode, sorted, nodeToMouseDistance, edgeDirection,
                { x: origin.x + scaledDeltas.x, y: origin.y + scaledDeltas.y});

        }, (ev, origin, root) => {
            this.isDragging = true;
            this.workflowBoundingClientRect = this.svgRoot.getBoundingClientRect();

            const originNode    = Workflow.findParentNode(origin);
            const originNodeCTM = originNode.getScreenCTM();

            originNodeCoords = this.translateMouseCoords(originNodeCTM.e, originNodeCTM.f);

            const isInputPort = origin.classList.contains("input-port");

            ghostIONode = GraphNode.createGhostIO();
            this.workflow.appendChild(ghostIONode);


            // Based on the type of our origin port, determine the direction of the path to draw
            edgeDirection = isInputPort ? "left" : "right";

            // Draw the edge to the cursor and store the element's reference
            edge = <SVGPathElement>GraphEdge.spawn();
            edge.classList.add("dragged");
            this.workflow.appendChild(edge);

            // We need the origin connection ID so we can ask CWLTS for connection recommendations
            const targetConnectionId = origin.getAttribute("data-connection-id");

            // Have a set of all ports of the opposite type, they are all possible destinations
            allConnectionPorts = Array.from(
                this.workflow.querySelectorAll(`.port.${isInputPort ? "output-port" : "input-port"}`)
            ).filter((el: SVGGElement) => {
                // Except the same node that we are dragging from
                return Workflow.findParentNode(el) !== originNode;
            }).map((el: SVGGElement) => {

                // Find the position of the port relative to the canvas origin
                el.wfCTM = Geometry.getTransformToElement(el, this.workflow);
                return el;
            });


            // Get all valid connection destinations
            preferredConnectionPorts = (this.model.gatherValidConnectionPoints(targetConnectionId) || [])
            // Take out just the visible ones
                .filter(point => point.isVisible)
                // Find them in the DOM and mark them as connection candidates
                .map(p => {
                    const el: SVGGElement = <SVGGElement>this.workflow.querySelector(`.port[data-connection-id="${p.connectionId}"]`);
                    el.wfCTM = Geometry.getTransformToElement(el, this.workflow);
                    el.classList.add("connection-suggestion");
                    return el;
                });

            // For all of the valid connection destinations, find their parent node element
            // and mark it as a highlighted and a connection candidate
            preferredConnectionPorts.forEach(el => {
                const parentNode = Workflow.findParentNode(el);
                parentNode.classList.add("highlighted", "connection-suggestion");
            });

            // Then mark the workflow itself, so it knows to fade out other stuff
            this.workflow.classList.add("has-suggestion", "edge-dragging");

        }, (ev, origin) => {
            highlightedPort = this.dragBoundaryInterval.highlightedPort || highlightedPort;
            this.isDragging = false;
            this.setDragBoundaryIntervalToDefault();

            /**
             * If a port is highlighted, that means that we are supposed to snap the connection to that port
             */
            if (highlightedPort) {
                /**
                 * Find the connection ids of origin port and the highlighted port
                 */
                let sourceID      = origin.getAttribute("data-connection-id");
                let destinationID = highlightedPort.getAttribute("data-connection-id");

                /**
                 * Swap their places in case you dragged out from input to output
                 */
                if (sourceID.startsWith("in")) {
                    const tmp     = sourceID;
                    sourceID      = destinationID;
                    destinationID = tmp;
                }

                /**
                 * Maybe you tried to connect ports that are already connected.
                 * If an edge with these connection IDs doesn't already exist, create it.
                 * Otherwise, prevent creation.
                 */

                if (!GraphEdge.findEdge(this.workflow, sourceID, destinationID)) {

                    this.eventHub.emit("beforeChange", {
                        type: "connect",
                    });

                    const newEdge = GraphEdge.spawnBetweenConnectionIDs(this.workflow, sourceID, destinationID);
                    this.attachEdgeHoverBehavior(newEdge);
                    this.model.connect(sourceID, destinationID);
                }

                // Deselect and cleanup
                highlightedPort.classList.remove("highlighted");
                highlightedPort = undefined;
            } else if (!ghostIONode.classList.contains("hidden")) {
                // If the ghost io node is not hidden, then we should create an input or an output


                // Take the port connection id, check if it's an input or an output and,
                // based on that, determine if we should create an input or an output.
                // Then create the i/o node.
                const portID    = origin.getAttribute("data-connection-id");
                const ioIsInput = portID.startsWith("in");

                this.eventHub.emit("beforeChange", {
                    type: `${ioIsInput ? 'input' : 'output'}.create`,
                });

                const newIO = GraphNode.patchModelPorts(ioIsInput
                    ? this.model.createInputFromPort(portID)
                    : this.model.createOutputFromPort(portID));


                // Check to see if cursor is on boundary (or boundaries)
                const boundary = this.getBoundaryZonesXYAxes(ev.clientX, ev.clientY);

                const mouseCoords = this.translateMouseCoords(ev.clientX, ev.clientY);
                let newX = mouseCoords.x;
                let newY = mouseCoords.y;
                if (boundary.x) {
                    newX = this.translateMouseCoords(boundary.x === -1 ? this.workflowBoundingClientRect.left + this.dragBoundary :
                        this.workflowBoundingClientRect.right - this.dragBoundary, 0).x;
                }
                if (boundary.y) {
                    newY = this.translateMouseCoords(0, boundary.y === -1 ? this.workflowBoundingClientRect.top + this.dragBoundary :
                        this.workflowBoundingClientRect.bottom - this.dragBoundary).y;
                }

                // Translate mouse coordinates to the canvas coordinates,
                // make a template for the graph node, create an element out of that,
                // and add that element to the dom
                const tpl         = GraphNode.makeTemplate(newX, newY, newIO);
                const el          = TemplateParser.parse(tpl);
                this.workflow.appendChild(el);

                // Update the cwlts model with the new x and y coords for this node
                this.setModelPosition(newIO, mouseCoords.x, mouseCoords.y);

                // Spawn an edge between origin and destination ports
                const edge = GraphEdge.spawnBetweenConnectionIDs(this.workflow, portID, newIO.connectionId);

                // This edge still gas no events bound to it, so fix that
                this.attachEdgeHoverBehavior(edge);

                // Re-scale the workflow so the label gets upscaled or downscaled properly

                this.scaleWorkflow(this.scale);
            }

            this.workflow.classList.remove("has-suggestion", "edge-dragging");
            Array.from(this.workflow.querySelectorAll(".connection-suggestion, .preferred-node, .preferred-port")).forEach(el => {
                el.classList.remove("connection-suggestion", "highlighted", "preferred-node", "preferred-port", edgeDirection);
            });

            const selection = this.workflow.querySelector(".selected") as SVGGElement;
            if (selection) {
                this.activateSelection(selection);
            }

            edge.remove();
            ghostIONode.remove();
            edge                     = undefined;
            ghostIONode              = undefined;
            originNodeCoords         = undefined;
            edgeDirection            = undefined;
            preferredConnectionPorts = undefined;
        });
    }

    /**
     * Goes through all the potential connection ports for a new path,
     * and sorts them by distance in ascending order
     * @param allConnectionPorts
     * @param coords
     * @returns {SVGGElement[]}
     */
    private getSortedConnectionPorts(allConnectionPorts: SVGGElement[], coords: { x: number, y: number}): SVGGElement[] {
        const sorted = allConnectionPorts.map(el => {
            const ctm   = el.wfCTM;
            el.distance = Geometry.distance(coords.x, coords.y, ctm.e, ctm.f);
            return el;
        }).sort((el1, el2) => {
            return el1.distance - el2.distance
        });
        return sorted;
    }

    /**
     * Removes highlighted port if a highlighted port exists
     * @param highlightedPort
     * @param edgeDirection
     */
    private removeHighlightedPort(highlightedPort: SVGGElement, edgeDirection: "left" | "right"): void {
        if (highlightedPort) {
            const parentNode = Workflow.findParentNode(highlightedPort);
            // highlightedPort.classList.remove("highlighted", "preferred-port");
            highlightedPort.classList.remove("highlighted", "preferred-port");
            // parentNode.classList.remove("highlighted", "preferred-node", edgeDirection);
            parentNode.classList.remove("preferred-node", edgeDirection);
        }
    }

    /**
     * Check if the closest connection port is within a certain distance.
     * If it is, highlight it, and if not, show the ghost node
     * @param ghostIONode
     * @param sorted
     * @param nodeToMouseDistance
     * @param edgeDirection
     * @param newCoords
     * @returns {SVGGElement}
     */
    private highlightPortOrShowGhostNode(ghostIONode: SVGGElement, sorted: SVGGElement[],
                                         nodeToMouseDistance: number,
                                         edgeDirection: "left" | "right",
                                         newCoords: { x: number, y: number }): SVGGElement {
        let highlightedPort;
        ghostIONode.classList.add("hidden");
        // If there is a port in close proximity, assume that we want to connect to it, so highlight it
        if (sorted.length && sorted[0].distance < 100) {
            highlightedPort = sorted[0];
            highlightedPort.classList.add("highlighted", "preferred-port");
            const parentNode = Workflow.findParentNode(highlightedPort);
            this.workflow.appendChild(parentNode);
            parentNode.classList.add("highlighted", "preferred-node", edgeDirection);
        } else {

            highlightedPort = undefined;

            if (nodeToMouseDistance > 120) {
                ghostIONode.classList.remove("hidden");
                // Otherwise, we might create an input or an ooutput node
            }
        }
        ghostIONode.transform.baseVal.getItem(0).setTranslate(newCoords.x, newCoords.y);
        return highlightedPort;
    }

    /**
     * Sets the dragBoundaryInterval object to its default values
     */
    private setDragBoundaryIntervalToDefault(): void {
        if (this.dragBoundaryInterval.interval) {
            clearInterval(this.dragBoundaryInterval.interval);
            this.dragBoundaryInterval.x = this.dragBoundaryInterval.y = false;
            this.dragBoundaryInterval.interval = null;
            this.dragBoundaryInterval.highlightedPort = undefined;
        }
        this.dragBoundaryInterval.xOffset = this.dragBoundaryInterval.yOffset = 0;
    }

    static findParentNode(el) {
        let parentNode = el;
        while (parentNode) {
            if (parentNode.classList.contains("node")) {
                return parentNode;
            }
            parentNode = parentNode.parentNode;
        }
    }

    setModelPosition(obj, x, y) {
        const update = {
            "sbg:x": x,
            "sbg:y": y
        };

        this.eventHub.emit("beforeChange", {
            type: "move",
        });

        if (!obj.customProps) {
            obj.customProps = update;
            return;
        }

        Object.assign(obj.customProps, update);
    }

    private clearCanvas() {
        this.domEvents.detachAll();
        this.workflow.innerHTML = "";
        this.workflow.setAttribute("class", "workflow");
    }

    private getOffsetFromCanvasCenter(x, y) {

        const abs = {
            x: x - this.svgRoot.clientWidth / 2,
            y: y - this.svgRoot.clientHeight / 2,
        };
        const pc  = {
            pcx: abs.x / this.svgRoot.clientWidth,
            pcy: abs.y / this.svgRoot.clientHeight
        };

        return {...abs, ...pc};
    }

    private activateSelection(el: SVGGElement) {
        this.deselectEverything();

        this.workflow.classList.add("has-selection");

        const nodeID = el.getAttribute("data-id");
        Array.from(this.workflow.querySelectorAll(`.edge.${nodeID}`)).forEach((edge: HTMLElement) => {
            edge.classList.add("highlighted");
            const sourceNodeID      = edge.getAttribute("data-source-node");
            const destinationNodeID = edge.getAttribute("data-destination-node");

            Array.from(this.workflow.querySelectorAll(`.node.${sourceNodeID}, .node.${destinationNodeID}`))
                .forEach((el: SVGGElement) => el.classList.add("highlighted"));
        });

        el.classList.add("selected");
        if (typeof el.focus === "function") {
            (el as any).focus();
        }
    }

    destroy() {
        this.clearCanvas();
        this.eventHub.empty();
    }
}
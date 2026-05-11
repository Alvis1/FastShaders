import AFRAME from 'aframe';
import * as THREE from 'three';

AFRAME.registerComponent('carousel', {
  schema: {
    radius: {type: 'number', default: 5},
    speed: {type: 'number', default: 1}, // degrees per second
    maxCount: {type: 'number', default: 10}
  },

  init: function () {
    this.templates = Array.from(this.el.children);
    if (this.templates.length === 0) {
      console.warn('Carousel: No child entities to use as templates.');
      return;
    }

    // Hide templates
    this.templates.forEach(template => {
      template.setAttribute('visible', false);
    });

    this.entities = [];
    this.angle = 0;
    this.completedRotations = 0;
    this.nextTemplateIndex = 0;
    this.occupiedVertices = new Set(); // Track which vertices are occupied
    
    // State management for final rotation and stop
    this.maxCountReached = false;
    this.finalRotationStartTime = 0;
    this.finalRotationDuration = 5000; // 5 seconds in milliseconds
    this.stopped = false;
    
    // Calculate vertices based on maxCount (invisible circle vertices)
    this.totalVertices = this.data.maxCount;
    this.vertices = this.calculateCircleVertices(this.totalVertices);

    // Create the first entity at vertex 0
    this.addEntity();
  },

  tick: function (time, timeDelta) {
    if (this.templates.length === 0 || this.stopped) return;

    // Handle final rotation period after max count reached
    if (this.maxCountReached) {
      if (time - this.finalRotationStartTime >= this.finalRotationDuration) {
        // Final rotation period is over, stop completely
        this.stopped = true;
        return;
      }
      // Continue rotating during final rotation period but don't add entities
    } else {
      // Normal operation: check for completed rotations and add entities
      const currentRotations = Math.floor(this.angle / 360);
      if (currentRotations > this.completedRotations) {
        this.completedRotations = currentRotations;
        
        // Add new entity only if we have available vertices
        if (this.entities.length < this.totalVertices) {
          this.addEntity();
          
          // Check if we've reached max count after adding
          if (this.entities.length === this.totalVertices) {
            this.maxCountReached = true;
            this.finalRotationStartTime = time;
          }
        }
      }
    }

    // Continue rotating (either normal operation or final rotation period)
    const rotationSpeed = this.data.speed; // degrees per second
    this.angle += (rotationSpeed * timeDelta) / 1000;
    this.el.object3D.rotation.y = THREE.MathUtils.degToRad(this.angle);
  },

  calculateCircleVertices: function (count) {
    const vertices = [];
    for (let i = 0; i < count; i++) {
      const angle = (i * 360) / count;
      const radian = THREE.MathUtils.degToRad(angle);
      vertices.push({
        index: i,
        angle: angle,
        x: this.data.radius * Math.cos(radian),
        z: this.data.radius * Math.sin(radian)
      });
    }
    return vertices;
  },

  findFurthestAvailableVertex: function () {
    if (this.entities.length === 0) {
      return 0; // First entity goes to vertex 0
    }

    let maxDistance = -1;
    let furthestVertex = -1;

    // Check each unoccupied vertex
    for (let i = 0; i < this.totalVertices; i++) {
      if (this.occupiedVertices.has(i)) continue;

      // Calculate minimum distance to all existing entities
      let minDistanceToExisting = Infinity;
      
      for (let j = 0; j < this.totalVertices; j++) {
        if (!this.occupiedVertices.has(j)) continue;
        
        // Calculate angular distance between vertices
        const angle1 = (i * 360) / this.totalVertices;
        const angle2 = (j * 360) / this.totalVertices;
        let angularDistance = Math.abs(angle1 - angle2);
        
        // Handle wrap-around (e.g., 350° to 10° should be 20°, not 340°)
        if (angularDistance > 180) {
          angularDistance = 360 - angularDistance;
        }
        
        minDistanceToExisting = Math.min(minDistanceToExisting, angularDistance);
      }

      // This vertex is furthest if its minimum distance to existing entities is maximum
      if (minDistanceToExisting > maxDistance) {
        maxDistance = minDistanceToExisting;
        furthestVertex = i;
      }
    }

    return furthestVertex;
  },

  addEntity: function () {
    const template = this.templates[this.nextTemplateIndex];
    const newEntity = template.cloneNode(true);
    
    // Explicitly copy the tsl-shader attribute to ensure it's not lost during cloning
    const shaderAttr = template.getAttribute('tsl-shader');
    if (shaderAttr) {
      newEntity.setAttribute('tsl-shader', shaderAttr);
      console.log(`Cloned entity with tsl-shader: ${shaderAttr}`);
    }
    
    newEntity.setAttribute('visible', true);
    
    // Find the furthest available vertex
    const vertexIndex = this.findFurthestAvailableVertex();
    
    if (vertexIndex === -1) {
      console.warn('Carousel: No available vertices for new entity');
      return;
    }

    // Mark this vertex as occupied
    this.occupiedVertices.add(vertexIndex);
    
    // Store vertex information in the entity
    newEntity.userData = { 
      vertexIndex: vertexIndex,
      vertex: this.vertices[vertexIndex]
    };
    
    this.el.appendChild(newEntity);
    this.entities.push(newEntity);
    
    this.nextTemplateIndex = (this.nextTemplateIndex + 1) % this.templates.length;

    this.updatePositions();
  },

  updatePositions: function () {
    // Place each entity at its assigned vertex position
    this.entities.forEach((entity) => {
      const vertex = entity.userData.vertex;
      entity.setAttribute('position', { 
        x: vertex.x, 
        y: 0, 
        z: vertex.z 
      });
    });
  }
});
